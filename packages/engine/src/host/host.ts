/**
 * The host loop.
 *
 * `requestAnimationFrame` is the pump, not the clock. Real elapsed time goes
 * into an accumulator and comes out as whole ticks; the leftover fraction goes
 * to the renderer as an interpolation factor, which it may only read. So frame
 * jitter changes how *many* ticks a frame runs and never how big one is, and
 * two players on the same seed play the same game whatever their displays are
 * doing.
 *
 * Clockwork 1 did the opposite: its rendering layer computed
 * `deltaTicks = ~~(ticker.deltaTime * 1000)` and handed it to the engine, so a
 * 16.4 ms frame ran 984 ticks and a 17.1 ms frame ran 1026.
 */

import {
  Accumulator,
  type Checkpoint,
  ClockworkError,
  type Counters,
  type Effect,
  fail,
  type GameModule,
  hashCanonical,
  type InputEvent,
  type InputSource,
  KERNEL_VERSION,
  LiveInputQueue,
  type Manifest,
  PackSet,
  type PlainValue,
  type Presentation,
  type PresentationContext,
  RECORDING_FORMAT,
  RECORDING_VERSION,
  type Recording,
  Session,
  type SessionResult,
  type Snapshot,
  servedConfig,
  type TerminalReason,
} from "../index.js"
import { browserScheduler, type Scheduler } from "./clock.js"
import { PackRequests, type PackSupply } from "./packs.js"

/**
 * Where a host is. `preparing` is the wait between `start` and the clock
 * starting, while a presentation's `prepare` runs.
 */
export type HostState = "idle" | "preparing" | "running" | "paused" | "ended"

export interface GameHostOptions<
  TView = unknown,
  TContainer = unknown,
  TConfig = PlainValue,
> {
  readonly module: GameModule<TView, TConfig>
  readonly manifest: Manifest
  readonly seed: string
  /**
   * The config the session plays. Left out, it is `servedConfig(manifest)`,
   * every declared parameter at its default, which is what a platform serves
   * a ranked or practice run and what the conformance checks play.
   */
  readonly config?: TConfig
  readonly presentation?: Presentation<TView, TContainer>
  readonly container?: TContainer
  readonly scheduler?: Scheduler
  /** Ticks between state hashes. Defaults to one second of play. */
  readonly checkpointEvery?: number
  /**
   * Where the session stops, with terminal `timeout`, if the game has not
   * ended it by then.
   *
   * A replay of a recording passes `Math.max(endTick, 1)`: the log ends
   * where the player stopped, and without a stop the replay carries on past
   * it and reports a different end tick for a session that did not diverge.
   * Left out, a session runs until the game ends it or `stop` is called.
   */
  readonly maxTicks?: number
  /** A multiplier on how fast the session advances. Replay speed lives here. */
  readonly speed?: number
  readonly onCheckpoint?: (checkpoint: Checkpoint) => void
  readonly onEffects?: (effects: readonly Effect[], tick: number) => void
  readonly onEnded?: (result: SessionResult) => void
  readonly onFrame?: (info: FrameInfo) => void
  readonly onError?: (error: unknown) => void
  /**
   * Where inputs come from. Left out, the host collects them from devices and
   * the session is a live one. Given a recorded source, the very same loop
   * replays it - which is the point: replay is not a second code path.
   */
  readonly inputs?: InputSource
  /** Continues from a snapshot instead of starting fresh. */
  readonly resumeFrom?: {
    readonly snapshot: Snapshot
    readonly tick: number
  }
  readonly presentationContext?: {
    readonly random: () => number
    readonly assets: ReadonlyMap<string, ArrayBuffer | string>
    readonly devicePixelRatio: number
    readonly theme: string
  }
  /**
   * The data packs. Every start pack must be preloaded, because the session
   * is built, and `init` runs, inside this constructor. Demand packs come
   * from the loader when the game hints at them or names them; while one it
   * named is missing, the host holds the loop.
   */
  readonly packs?: PackSupply
}

export interface FrameInfo {
  readonly tick: number
  readonly ticksThisFrame: number
  readonly alpha: number
  readonly elapsedMs: number
  /** The packs the loop is holding for. Empty while it runs. */
  readonly waitingFor: readonly string[]
}

export interface LoopStats {
  readonly frames: number
  readonly ticksRun: number
  readonly mostTicksInAFrame: number
  readonly droppedMs: number
}

export class GameHost<
  TView = unknown,
  TContainer = unknown,
  TConfig = PlainValue,
> {
  /** Present only for a live session; a replay reads its recorded source. */
  readonly live: LiveInputQueue | null
  private readonly source: InputSource
  private readonly accumulator: Accumulator
  private readonly scheduler: Scheduler
  private session: Session<TView, TConfig>
  private state: HostState = "idle"
  private handle: number | null = null
  private lastNow = 0
  private previousView: TView | null = null
  private mounted = false
  /** While a presentation's `prepare` runs: what `start` hands every caller. */
  private preparing: Promise<boolean> | null = null
  private ticksRun = 0
  private speed: number
  /** Real time that passed while the loop held for a pack. */
  private heldMs = 0
  /** Frames that ran no tick because the loop was holding from their start. */
  private heldFrames = 0
  private readonly requests: PackRequests
  private readonly packs: PackSet
  /** The config given, or the served one: what the session and its recording carry. */
  private readonly config: TConfig

  constructor(
    private readonly options: GameHostOptions<TView, TContainer, TConfig>,
  ) {
    this.config =
      options.config ?? (servedConfig(options.manifest) as unknown as TConfig)
    this.packs = PackSet.verify(
      options.manifest.assets,
      options.packs?.preloaded ?? [],
    )
    this.requests = new PackRequests(
      options.packs?.loader,
      (path, bytes) => {
        this.session.deliver(path, bytes)
      },
      (error) => {
        this.fail(error)
      },
      (path) => this.session.holds(path),
    )
    this.scheduler = options.scheduler ?? browserScheduler()
    this.accumulator = new Accumulator({
      tickHz: options.manifest.session.tickHz,
    })
    this.speed = options.speed ?? 1
    if (options.inputs === undefined) {
      const queue = new LiveInputQueue(options.manifest.inputs)
      this.live = queue
      this.source = queue
    } else {
      this.live = null
      this.source = options.inputs
    }
    this.session = this.createSession()
  }

  private createSession(): Session<TView, TConfig> {
    return new Session<TView, TConfig>({
      module: this.options.module,
      seed: this.options.seed,
      config: this.config,
      inputs: this.source,
      ...(this.options.maxTicks === undefined
        ? {}
        : { maxTicks: this.options.maxTicks }),
      checkpointEvery:
        this.options.checkpointEvery ?? this.options.manifest.session.tickHz,
      counters: this.options.manifest.counters,
      assets: this.options.manifest.assets ?? [],
      packs: this.packs,
      ...(this.options.onCheckpoint === undefined
        ? {}
        : { onCheckpoint: this.options.onCheckpoint }),
      onEffects: (effects, tick) => {
        this.requests.prefetch(effects)
        this.options.onEffects?.(effects, tick)
      },
      ...(this.options.resumeFrom === undefined
        ? {}
        : { resumeFrom: this.options.resumeFrom }),
    })
  }

  get tick(): number {
    return this.session.tick
  }

  /**
   * The manifest this session runs under.
   *
   * Public because the frame bridge needs its hash for the `ready` message,
   * and reaching into the options object to get it was a cast that would
   * survive the field being renamed.
   */
  get manifest(): Manifest {
    return this.options.manifest
  }

  get seed(): string {
    return this.options.seed
  }

  get status(): HostState {
    return this.state
  }

  /**
   * What the loop did. `droppedMs` counts the time it held for a pack as well
   * as the time it dropped, because both are real time that produced no
   * ticks, and a platform deciding whether a run was slow needs to see both.
   */
  get stats(): LoopStats {
    const accumulator = this.accumulator.stats
    return {
      frames: accumulator.frames + this.heldFrames,
      ticksRun: this.ticksRun,
      mostTicksInAFrame: accumulator.mostTicksInAFrame,
      droppedMs: accumulator.droppedMs + this.heldMs,
    }
  }

  /** The packs the loop is holding for right now. */
  get waitingFor(): readonly string[] {
    return this.session.packsMissing()
  }

  /** How far between the last tick and the next, for the renderer. */
  get alpha(): number {
    return this.accumulator.alpha
  }

  setSpeed(speed: number): void {
    if (!Number.isFinite(speed) || speed <= 0) {
      fail("E_ARG_INVALID", {
        detail: `speed must be a positive number, got ${speed}`,
      })
    }
    // Replay speed belongs here rather than in the renderer. Clockwork 1 set
    // it on PIXI's ticker, which made how fast the game ran a property of the
    // thing drawing it.
    this.speed = speed
  }

  private get context(): PresentationContext {
    return (
      this.options.presentationContext ?? {
        random: () => 0.5,
        assets: new Map(),
        devicePixelRatio: 1,
        theme: "light",
      }
    )
  }

  private mount(): void {
    const { presentation, container } = this.options
    if (presentation === undefined || container === undefined || this.mounted)
      return
    presentation.mount(container, this.context)
    this.mounted = true
  }

  /**
   * Starts the session's clock.
   *
   * A presentation with `prepare` is mounted, then prepared, and the clock
   * starts only when `prepare` resolves. Until then `status` is
   * `"preparing"`, no tick runs and the live queue takes no input, so nothing
   * the player does before the game can draw is recorded. A presentation
   * without `prepare`, or no presentation, starts the clock before `start`
   * returns, as it always has.
   *
   * @returns whether the clock is running: true once it is, false when it
   *   never will, because the session has ended, `prepare` rejected (reported
   *   through `onError` as `E_PRESENTATION_FAILED`), or the host was stopped
   *   or destroyed while `prepare` ran. It never rejects, so a caller with
   *   nothing to wait for may leave it.
   */
  start(): Promise<boolean> {
    if (this.state === "running") return Promise.resolve(true)
    // A finished session does not restart. Without this, start() on an ended
    // host schedules a frame, session.step() returns false immediately, and
    // finish() fires onEnded a second time - so a host bridge sends a second
    // `ended` and a second recording for one run. A shell that starts twice,
    // which a re-rendering effect does by itself, is enough to trigger it.
    if (this.state === "ended") return Promise.resolve(false)
    if (this.preparing !== null) return this.preparing
    this.mount()
    const { presentation, container } = this.options
    // Prepared once, from idle: a paused host that is started again goes on
    // as it did before prepare existed.
    if (
      this.state !== "idle" ||
      !this.mounted ||
      presentation?.prepare === undefined ||
      container === undefined
    ) {
      this.run()
      return Promise.resolve(true)
    }
    this.state = "preparing"
    this.live?.pause()
    let ready: Promise<void>
    try {
      ready = Promise.resolve(presentation.prepare(container, this.context))
    } catch (error) {
      ready = Promise.reject(error)
    }
    const preparing = ready.then(
      () => {
        this.preparing = null
        // Stopped or destroyed while it waited: nothing starts.
        if (this.state !== "preparing") return false
        this.live?.resume()
        this.run()
        return true
      },
      (error: unknown) => {
        this.preparing = null
        if (this.state !== "preparing") return false
        this.fail(
          new ClockworkError("E_PRESENTATION_FAILED", {
            detail: error instanceof Error ? error.message : String(error),
            cause: error,
          }),
        )
        return false
      },
    )
    this.preparing = preparing
    return preparing
  }

  /** Starts the clock now. */
  private run(): void {
    this.state = "running"
    this.lastNow = this.scheduler.now()
    this.schedule()
  }

  pause(): void {
    if (this.state !== "running") return
    this.state = "paused"
    this.unschedule()
    // Whatever the player holds is released into the log, and nothing more
    // is taken until the run resumes.
    this.live?.pause()
  }

  resume(): void {
    if (this.state !== "paused") return
    this.state = "running"
    this.live?.resume()
    // The clock restarts here rather than carrying the pause forward, so a
    // paused tab does not come back owing four minutes of simulation.
    this.lastNow = this.scheduler.now()
    this.schedule()
  }

  /** Ends the session without finishing it, for a player who walked away. */
  stop(reason: TerminalReason = "abandoned"): void {
    if (this.state === "ended") return
    this.requests.close()
    this.unschedule()
    this.session.abandon(reason)
    this.state = "ended"
    this.options.onEnded?.(this.session.result())
  }

  private schedule(): void {
    this.handle = this.scheduler.request((now) => {
      this.handle = null
      this.frame(now)
    })
  }

  private unschedule(): void {
    if (this.handle !== null) {
      this.scheduler.cancel(this.handle)
      this.handle = null
    }
  }

  /**
   * Holds the loop for packs the next tick needs.
   *
   * The time is not fed to the accumulator, so nothing is banked and no burst
   * of ticks follows the arrival; it is counted in `droppedMs` instead.
   */
  private hold(missing: readonly string[], ms: number): void {
    this.heldMs += ms
    for (const path of missing) this.requests.request(path, true)
  }

  private fail(error: unknown): void {
    if (this.state === "ended") return
    this.requests.close()
    this.unschedule()
    this.state = "ended"
    this.options.onError?.(error)
  }

  private frame(now: number): void {
    if (this.state !== "running") return
    const elapsed = (now - this.lastNow) * this.speed
    this.lastNow = now
    // Polled devices are read before the ticks, so what a gamepad shows at
    // the start of this frame lands on the first tick it runs, live and in
    // the recording alike.
    this.live?.poll()

    let ticksThisFrame = 0
    const waiting = this.session.packsMissing()
    if (waiting.length > 0) {
      // The accumulator never sees this frame, so it is counted here.
      this.heldFrames++
      this.hold(waiting, elapsed)
      if (this.state !== "running") return
      this.render(elapsed)
      this.reportFrame(0, elapsed)
      this.schedule()
      return
    }
    try {
      const steps = this.accumulator.frame(elapsed)
      for (let i = 0; i < steps; i++) {
        const missing = this.session.packsMissing()
        if (missing.length > 0) {
          // The accumulator already took this frame's time for the steps
          // that will not run now.
          this.hold(missing, (steps - i) * this.accumulator.stepMs)
          if (this.state !== "running") return
          break
        }
        const previous = this.options.module.view()
        if (!this.session.step()) {
          ticksThisFrame++
          this.ticksRun++
          this.previousView = previous
          this.finish()
          return
        }
        ticksThisFrame++
        this.ticksRun++
        this.previousView = previous
      }
    } catch (error) {
      this.fail(error)
      return
    }

    this.render(elapsed)
    this.reportFrame(ticksThisFrame, elapsed)
    this.schedule()
  }

  private reportFrame(ticksThisFrame: number, elapsedMs: number): void {
    this.options.onFrame?.({
      tick: this.session.tick,
      ticksThisFrame,
      alpha: this.accumulator.alpha,
      elapsedMs,
      waitingFor: this.session.packsMissing(),
    })
  }

  private render(elapsedMs: number): void {
    const { presentation } = this.options
    if (presentation === undefined || !this.mounted) return
    presentation.render(
      this.options.module.view(),
      this.previousView,
      this.accumulator.alpha,
      elapsedMs,
    )
  }

  private finish(): void {
    this.requests.close()
    this.unschedule()
    this.state = "ended"
    this.render(0)
    this.options.onEnded?.(this.session.result())
  }

  /**
   * Runs one tick by hand, for a test that wants no frame pacing at all.
   *
   * It cannot wait for a download, so it throws `E_PACK_NOT_DELIVERED` at a
   * tick whose demand pack is not here. A test stepping a game with demand
   * packs preloads them all, with `loadPacks(manifest, loader, "all")`.
   */
  stepOnce(): boolean {
    const running = this.session.step()
    this.ticksRun++
    if (!running) {
      this.requests.close()
      this.state = "ended"
      this.options.onEnded?.(this.session.result())
    }
    return running
  }

  result(): SessionResult {
    return this.session.result()
  }

  counters(): Counters {
    return this.options.module.score()
  }

  snapshot(): Snapshot {
    return this.options.module.snapshot()
  }

  /** What the renderer sees. Read it; writing to it is not a supported idea. */
  view(): TView {
    return this.options.module.view()
  }

  /**
   * The recording this session produced, ready to submit or replay.
   *
   * A replayed session has no live queue, so it reports the log it was given
   * rather than an empty one; `recordingFrom` is how a caller passes it.
   */
  recording(
    inputs: readonly InputEvent[] = this.live?.recorded() ?? [],
  ): Recording {
    const result = this.session.result()
    return {
      format: RECORDING_FORMAT,
      version: RECORDING_VERSION,
      kernelVersion: KERNEL_VERSION,
      gameId: this.options.manifest.id,
      gameVersion: this.options.manifest.version,
      manifestHash: hashCanonical(this.options.manifest as never),
      tickHz: this.options.manifest.session.tickHz,
      seed: this.options.seed,
      config: this.config as PlainValue,
      inputs,
      checkpoints: result.checkpoints,
      endTick: result.endTick,
      terminal: result.terminal,
      counters: result.counters,
      // What the loop did while this was happening. A replay ignores it; a
      // platform reads it to tell a slow phone from a cheat.
      hostStats: this.stats,
    }
  }

  destroy(): void {
    this.requests.close()
    this.unschedule()
    const { presentation } = this.options
    if (presentation !== undefined && this.mounted) {
      presentation.unmount()
      this.mounted = false
    }
    this.state = "ended"
  }
}
