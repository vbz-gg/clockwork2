/**
 * The fixed-step driver, shared by the browser host and the server validator.
 *
 * There is one of these on purpose. Clockwork 1 replayed a session by handing
 * the engine one `update(totalTicks)` call for the whole recording, which is
 * not the computation that produced it: a skipped interval timer fired
 * repeatedly inside that single update, bounded by a 1,000-iteration guard.
 * Here the validator runs the same `step()` the browser ran, the same number
 * of times, so "replay" is not an approximation of the original run - it is
 * the original run.
 *
 * The host drives `Session.step()` from its accumulator; the validator calls
 * `runSession`, which is a `for` loop over the same method.
 */

import type {
  Counters,
  Effect,
  GameModule,
  PlainValue,
  Snapshot,
  TerminalReason,
} from "./contract.js"
import { type CounterDeclaration, CounterTracker } from "./counters.js"
import { ClockworkError, fail } from "./errors.js"
import { hashCanonical } from "./hash/canonical.js"
import type { InputSource } from "./inputs.js"
import type { AssetDeclaration } from "./manifest/types.js"
import {
  decodeJsonPack,
  isStartPack,
  logicPacks,
  type PackBytes,
  type PackReader,
  type PackSet,
  prefetchPaths,
  verified,
  verifyPack,
} from "./packs.js"
import { installShims, uninstallShims } from "./shims.js"

export type Checkpoint = {
  readonly tick: number
  readonly hash: string
}

export interface SessionResult {
  /** How many ticks ran. */
  readonly endTick: number
  readonly terminal: TerminalReason
  readonly counters: Counters
  readonly checkpoints: readonly Checkpoint[]
  readonly snapshot: Snapshot
}

export interface SessionOptions<TView = unknown, TConfig = PlainValue> {
  readonly module: GameModule<TView, TConfig>
  readonly seed: string
  readonly config: TConfig
  readonly inputs: InputSource
  /** The tick cap from the manifest. The run ends here whatever the game says. */
  readonly maxTicks: number
  /** Ticks between state hashes. 0 turns checkpointing off. */
  readonly checkpointEvery?: number
  /** Declared counters, checked as the run goes. */
  readonly counters?: readonly CounterDeclaration[]
  /** Set false only in a test that is measuring the cost of the traps. */
  readonly shims?: boolean
  readonly onCheckpoint?: (checkpoint: Checkpoint) => void
  readonly onEffects?: (effects: readonly Effect[], tick: number) => void
  readonly onTick?: (tick: number) => void
  /**
   * The manifest's assets. The ones marked `requiredForSim` are the packs this
   * game may read. Left out, the session has no packs and any read is
   * refused with `E_PACK_NOT_DELIVERED`.
   */
  readonly assets?: readonly AssetDeclaration[]
  /**
   * Packs the kernel has already checked. Every start pack must be here,
   * because `init` runs inside the constructor and may read one. Demand packs
   * may be here too, or arrive later through `deliver`.
   */
  readonly packs?: PackSet
  /**
   * Continues from a snapshot instead of starting fresh.
   *
   * `init` still runs first, so that whatever the game declares there -
   * timer handlers above all - exists before the snapshot is bound onto it.
   * Restoring into a module that never ran `init` is how a restored timer
   * finds no handler to call.
   */
  readonly resumeFrom?: {
    readonly snapshot: Snapshot
    readonly tick: number
  }
}

const NO_PACKS: readonly string[] = []

type Reading = "init" | "restore" | "tick"

function isThenable(value: unknown): boolean {
  return (
    value !== null &&
    (typeof value === "object" || typeof value === "function") &&
    typeof (value as { then?: unknown }).then === "function"
  )
}

/**
 * One run of one game.
 *
 * Construct it and the game is initialised; call `step()` until it returns
 * false; call `result()` for what happened.
 */
export class Session<TView = unknown, TConfig = PlainValue> {
  private readonly options: SessionOptions<TView, TConfig>
  private readonly tracker: CounterTracker
  private readonly collected: Checkpoint[] = []
  private ticksRun = 0
  private over = false
  private terminal: TerminalReason = "abandoned"

  /** The packs this game may read, or null when no assets were given. */
  private readonly declared: ReadonlyMap<string, AssetDeclaration> | null
  /** Start packs: readable in init, restore and every tick. */
  private readonly start: ReadonlySet<string>
  /** Packs checked before the session, possibly shared with other sessions. */
  private readonly shared: ReadonlyMap<string, Uint8Array>
  /** Demand packs delivered to this session alone. */
  private readonly own = new Map<string, Uint8Array>()
  /** Demand packs `packsNeeded()` has named since they were last released. */
  private readonly named = new Set<string>()
  /** What `packsNeeded()` said for the next tick. */
  private needed: readonly string[] = NO_PACKS
  private readable: ReadonlySet<string>
  /** Which of the game's calls is running, while one that may read is. */
  private reading: Reading | null = null

  /**
   * What the game reads its packs through. `init` receives it; the same
   * object serves the whole session.
   */
  readonly packs: PackReader

  constructor(options: SessionOptions<TView, TConfig>) {
    this.options = options
    this.tracker = new CounterTracker(options.counters ?? [])
    if (!Number.isInteger(options.maxTicks) || options.maxTicks <= 0) {
      fail("E_ARG_INVALID", {
        detail: `maxTicks must be a positive whole number, got ${options.maxTicks}`,
      })
    }

    this.declared =
      options.assets === undefined ? null : logicPacks(options.assets)
    this.shared = this.sharedPacks(options.packs)
    const start = new Set<string>()
    for (const asset of this.declared?.values() ?? []) {
      if (isStartPack(asset)) start.add(asset.path)
    }
    this.start = start
    this.readable = start
    const absent = [...start].filter((path) => !this.shared.has(path))
    if (absent.length > 0) {
      fail("E_PACK_NOT_DELIVERED", {
        tick: 0,
        detail: `start pack ${absent.join(", ")} must be given before init`,
      })
    }
    this.packs = {
      open: (path) => this.packBytes(path).slice(),
      json: (path) => decodeJsonPack(this.packBytes(path), path),
    }

    this.calling("init", () => {
      const returned = options.module.init(
        options.seed,
        options.config,
        this.packs,
      ) as unknown
      if (isThenable(returned)) {
        fail("E_ASYNC_TICK", { tick: 0, detail: "init() returned a thenable" })
      }
    })
    const resume = options.resumeFrom
    if (resume !== undefined) {
      this.calling("restore", () => {
        options.module.restore(resume.snapshot)
      })
      this.ticksRun = resume.tick
      options.inputs.seek?.(resume.tick)
    }
    // A checkpoint at the starting tick pins the state a run began from, so a
    // divergence in setup is told apart from one in the first second of play.
    this.maybeCheckpoint(this.ticksRun, true)
    this.askPacksNeeded()
  }

  /**
   * The packs a set holds, after making sure they were checked against the
   * same entries this session declares. A set checked against another version
   * of the manifest would otherwise hand this one bytes it never declared.
   */
  private sharedPacks(
    set: PackSet | undefined,
  ): ReadonlyMap<string, Uint8Array> {
    if (set === undefined) return new Map()
    const { declared, bytes } = verified(set)
    for (const path of bytes.keys()) {
      const mine = this.declared?.get(path)
      const theirs = declared.get(path) as AssetDeclaration
      if (mine === undefined) {
        fail("E_PACK_UNDECLARED", {
          detail: `${path} is in the packs given, and not a pack this session's assets declare`,
        })
      }
      if (mine.sha256 !== theirs.sha256 || mine.bytes !== theirs.bytes) {
        fail("E_PACK_HASH_MISMATCH", {
          detail: `${path} was checked against a different manifest entry`,
        })
      }
    }
    return bytes
  }

  /** The bytes behind a read, after every rule about reading has held. */
  private packBytes(path: string): Uint8Array {
    const tick = this.ticksRun
    if (this.declared === null) {
      fail("E_PACK_NOT_DELIVERED", {
        tick,
        detail: `${path}: this session was started without the manifest's assets, so it has no packs`,
      })
    }
    if (!this.declared.has(path)) {
      fail("E_PACK_UNDECLARED", {
        tick,
        detail: `${path} is not a pack this manifest declares`,
      })
    }
    if (this.reading === null) {
      fail("E_PACK_NOT_REQUESTED", {
        tick,
        detail: `${path} was read outside init, restore and tick, where what is readable depends on the host`,
      })
    }
    if (!this.readable.has(path)) {
      fail("E_PACK_NOT_REQUESTED", {
        tick,
        detail:
          this.reading === "tick"
            ? `${path} is a demand pack, and packsNeeded() did not name it before tick ${tick}`
            : `${path} is a demand pack, which ${this.reading}() cannot read`,
      })
    }
    // A readable pack is always here: start packs are checked before init,
    // and step() refuses to run a tick whose named packs are missing.
    return (this.own.get(path) ?? this.shared.get(path)) as Uint8Array
  }

  /** Runs one of the game's calls that may read packs. */
  private calling(reading: Reading, body: () => void): void {
    this.reading = reading
    try {
      this.guarded(body)
    } finally {
      this.reading = null
    }
  }

  /** Asks the game what the next tick will read, once per tick. */
  private askPacksNeeded(): void {
    const { module } = this.options
    const ask = module.packsNeeded
    if (ask === undefined) return
    const tick = this.ticksRun
    const names = this.guarded(() => ask.call(module) as unknown)
    if (!Array.isArray(names)) {
      fail("E_PACK_UNDECLARED", {
        tick,
        detail: "packsNeeded() must return an array of pack paths",
      })
    }
    this.needed = this.checkNames(names, "packsNeeded()", tick)
  }

  /** Every name the game hands the kernel must be a declared pack. */
  private checkNames(
    names: readonly unknown[],
    where: string,
    tick: number,
  ): readonly string[] {
    if (names.length === 0) return NO_PACKS
    if (this.declared === null) {
      fail("E_PACK_NOT_DELIVERED", {
        tick,
        detail: `${where} named packs, and this session was started without the manifest's assets`,
      })
    }
    const out: string[] = []
    for (const name of names) {
      if (typeof name !== "string" || !this.declared.has(name)) {
        fail("E_PACK_UNDECLARED", {
          tick,
          detail: `${where} named ${JSON.stringify(name)}, which is not a pack this manifest declares`,
        })
      }
      if (!out.includes(name)) out.push(name)
    }
    return out
  }

  /**
   * The packs the next tick needs that this session does not have yet. A
   * host holds its loop while this is not empty and delivers what it names.
   */
  packsMissing(): readonly string[] {
    if (this.over) return NO_PACKS
    return this.needed.filter(
      (path) => !this.own.has(path) && !this.shared.has(path),
    )
  }

  /** Whether this session has the pack's bytes now, given or delivered. */
  holds(path: string): boolean {
    return this.own.has(path) || this.shared.has(path)
  }

  /**
   * Hands a demand pack to this session. The kernel checks it and keeps its
   * own copy, so the caller may reuse or transfer the buffer afterwards. A
   * pack the session already has is left as it is.
   *
   * @throws E_PACK_UNDECLARED, E_PACK_TOO_LARGE or E_PACK_HASH_MISMATCH
   */
  deliver(path: string, bytes: PackBytes): void {
    const asset = this.declared?.get(path)
    if (asset === undefined) {
      fail("E_PACK_UNDECLARED", {
        tick: this.ticksRun,
        detail: `${path} is not a pack this manifest declares`,
      })
    }
    if (this.own.has(path) || this.shared.has(path)) return
    this.own.set(path, verifyPack(asset, bytes))
  }

  private guarded<T>(body: () => T): T {
    if (this.options.shims === false) return body()
    installShims()
    try {
      return body()
    } finally {
      uninstallShims()
    }
  }

  get tick(): number {
    return this.ticksRun
  }

  get running(): boolean {
    return !this.over
  }

  get checkpoints(): readonly Checkpoint[] {
    return this.collected
  }

  private maybeCheckpoint(tick: number, force = false): void {
    const every = this.options.checkpointEvery ?? 0
    if (every <= 0) return
    if (!force && tick % every !== 0) return
    const checkpoint: Checkpoint = {
      tick,
      hash: hashCanonical(this.options.module.snapshot()),
    }
    this.collected.push(checkpoint)
    this.options.onCheckpoint?.(checkpoint)
  }

  /**
   * Runs exactly one tick.
   *
   * @returns whether the session is still running afterwards
   */
  step(): boolean {
    if (this.over) return false
    const { module, inputs } = this.options
    const tick = this.ticksRun

    const missing = this.packsMissing()
    if (missing.length > 0) {
      fail("E_PACK_NOT_DELIVERED", {
        tick,
        detail: `packsNeeded() named ${missing.join(", ")} for this tick, and it was not delivered`,
      })
    }
    this.handOver()

    const events = inputs.take(tick)
    this.calling("tick", () => {
      const returned = module.tick(events) as unknown
      if (isThenable(returned)) {
        fail("E_ASYNC_TICK", { tick })
      }
    })
    this.ticksRun++

    // Effects are drained every tick whether or not anyone is listening, or a
    // headless run accumulates them until it runs out of memory.
    const effects = module.effects()
    if (effects.length > 0) {
      for (const effect of effects) {
        const paths = prefetchPaths(effect)
        if (paths !== null) this.checkNames(paths, "a prefetch effect", tick)
      }
      this.options.onEffects?.(effects, tick)
    }

    this.options.onTick?.(this.ticksRun)

    const isOver = module.isOver()
    if (
      this.options.counters !== undefined &&
      this.options.counters.length > 0
    ) {
      this.tracker.check(module.score(), isOver, this.ticksRun)
    }

    this.maybeCheckpoint(this.ticksRun)

    if (isOver) {
      this.over = true
      this.terminal = "completed"
      // A final checkpoint, so the last state is always pinned even when the
      // run ends between two regular ones.
      this.maybeCheckpoint(this.ticksRun, true)
      return false
    }
    if (this.ticksRun >= this.options.maxTicks) {
      this.over = true
      this.terminal = "timeout"
      this.maybeCheckpoint(this.ticksRun, true)
      return false
    }
    this.askPacksNeeded()
    return true
  }

  /**
   * Makes what `packsNeeded()` named readable for the tick about to run, and
   * releases what it stopped naming.
   *
   * A demand pack this session was given through `deliver` is dropped once it
   * has been named and then is not, so a long run through many areas does not
   * hold every one of them. If the game names it again, `packsMissing` says
   * so and the host delivers it again; what the game can read never depends
   * on whether that happened quickly. A pack prefetched and not yet named is
   * kept, and so is everything in a shared set.
   */
  private handOver(): void {
    for (const path of this.named) {
      if (!this.needed.includes(path)) {
        this.named.delete(path)
        this.own.delete(path)
      }
    }
    for (const path of this.needed) this.named.add(path)
    this.readable =
      this.needed.length === 0
        ? this.start
        : new Set([...this.start, ...this.needed])
  }

  /** Ends the session early, for a player who walked away or a host error. */
  abandon(reason: TerminalReason = "abandoned"): void {
    if (this.over) return
    this.over = true
    this.terminal = reason
    this.maybeCheckpoint(this.ticksRun, true)
  }

  result(): SessionResult {
    return {
      endTick: this.ticksRun,
      terminal: this.terminal,
      counters: this.options.module.score(),
      checkpoints: this.collected,
      snapshot: this.options.module.snapshot(),
    }
  }
}

/** Drives a session to its end. This is what the validator runs. */
export function runSession<TView = unknown, TConfig = PlainValue>(
  options: SessionOptions<TView, TConfig>,
): SessionResult {
  const session = new Session(options)
  while (session.step()) {
    // The body is the point: one call per tick, exactly as the browser ran it.
  }
  return session.result()
}

/**
 * The accumulator a browser host runs.
 *
 * `requestAnimationFrame` stays variable; it is the pump, not the clock. Frame
 * jitter decides how *many* ticks run in a frame, never how *big* a tick is,
 * and the leftover is handed to the renderer as an interpolation factor, which
 * it may only read.
 *
 * Both limits below exist for the same reason: a tab that was backgrounded for
 * four minutes must not come back and run fourteen thousand ticks in one
 * frame. The debt is dropped rather than banked, and the drop is visible in
 * `droppedMs` so the host can record how far the session actually reached.
 */
export interface AccumulatorOptions {
  readonly tickHz: number
  /** The most ticks one frame may run before the rest of the debt is dropped. */
  readonly maxCatchUpTicks?: number
  /** The most real time one frame may contribute. */
  readonly maxFrameMs?: number
}

export const DEFAULT_MAX_CATCHUP_TICKS = 5
export const DEFAULT_MAX_FRAME_MS = 250

export class Accumulator {
  readonly stepMs: number
  private readonly maxCatchUpTicks: number
  private readonly maxFrameMs: number
  private carried = 0
  private droppedMs = 0
  private mostTicksInAFrame = 0
  private frames = 0

  constructor(options: AccumulatorOptions) {
    if (!Number.isFinite(options.tickHz) || options.tickHz <= 0) {
      fail("E_ARG_INVALID", {
        detail: `tickHz must be positive, got ${options.tickHz}`,
      })
    }
    this.stepMs = 1000 / options.tickHz
    this.maxCatchUpTicks = options.maxCatchUpTicks ?? DEFAULT_MAX_CATCHUP_TICKS
    this.maxFrameMs = options.maxFrameMs ?? DEFAULT_MAX_FRAME_MS
  }

  /**
   * Adds a frame's elapsed time and says how many whole ticks to run.
   *
   * The caller runs that many steps and then reads `alpha` for the renderer.
   */
  frame(elapsedMs: number): number {
    this.frames++
    const usable = Math.min(Math.max(elapsedMs, 0), this.maxFrameMs)
    if (elapsedMs > this.maxFrameMs)
      this.droppedMs += elapsedMs - this.maxFrameMs
    this.carried += usable

    let steps = 0
    while (this.carried >= this.stepMs && steps < this.maxCatchUpTicks) {
      this.carried -= this.stepMs
      steps++
    }
    if (steps === this.maxCatchUpTicks && this.carried >= this.stepMs) {
      // Drop the rest rather than spiral. Banking it would turn a stall into a
      // burst of input-free ticks, which is both unplayable and unverifiable.
      this.droppedMs += this.carried
      this.carried = 0
    }
    if (steps > this.mostTicksInAFrame) this.mostTicksInAFrame = steps
    return steps
  }

  /** How far between the last tick and the next, in [0, 1). */
  get alpha(): number {
    return this.carried / this.stepMs
  }

  get stats(): {
    readonly frames: number
    readonly droppedMs: number
    readonly mostTicksInAFrame: number
  } {
    return {
      frames: this.frames,
      droppedMs: this.droppedMs,
      mostTicksInAFrame: this.mostTicksInAFrame,
    }
  }

  reset(): void {
    this.carried = 0
    this.droppedMs = 0
    this.mostTicksInAFrame = 0
    this.frames = 0
  }
}

export { ClockworkError }
