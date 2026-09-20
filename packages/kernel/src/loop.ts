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
} from "./contract"
import { type CounterDeclaration, CounterTracker } from "./counters"
import { ClockworkError, fail } from "./errors"
import { hashCanonical } from "./hash/canonical"
import type { InputSource } from "./inputs"
import { installShims, uninstallShims } from "./shims"

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

  constructor(options: SessionOptions<TView, TConfig>) {
    this.options = options
    this.tracker = new CounterTracker(options.counters ?? [])
    if (!Number.isInteger(options.maxTicks) || options.maxTicks <= 0) {
      throw new RangeError(
        `maxTicks must be a positive whole number, got ${options.maxTicks}`,
      )
    }
    this.guarded(() => {
      const returned = options.module.init(
        options.seed,
        options.config,
      ) as unknown
      if (isThenable(returned)) {
        fail("E_ASYNC_TICK", { tick: 0, detail: "init() returned a thenable" })
      }
    })
    const resume = options.resumeFrom
    if (resume !== undefined) {
      this.guarded(() => {
        options.module.restore(resume.snapshot)
      })
      this.ticksRun = resume.tick
      options.inputs.seek?.(resume.tick)
    }
    // A checkpoint at the starting tick pins the state a run began from, so a
    // divergence in setup is told apart from one in the first second of play.
    this.maybeCheckpoint(this.ticksRun, true)
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

    const events = inputs.take(tick)
    this.guarded(() => {
      const returned = module.tick(events) as unknown
      if (isThenable(returned)) {
        fail("E_ASYNC_TICK", { tick })
      }
    })
    this.ticksRun++

    // Effects are drained every tick whether or not anyone is listening, or a
    // headless run accumulates them until it runs out of memory.
    const effects = module.effects()
    if (effects.length > 0) this.options.onEffects?.(effects, tick)

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
    return true
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
      throw new RangeError(`tickHz must be positive, got ${options.tickHz}`)
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
