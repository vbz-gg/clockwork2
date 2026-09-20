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
  type Counters,
  type Effect,
  type GameModule,
  hashCanonical,
  type InputEvent,
  type InputSource,
  KERNEL_VERSION,
  LiveInputQueue,
  type Manifest,
  type PlainValue,
  type Presentation,
  RECORDING_FORMAT,
  RECORDING_VERSION,
  type Recording,
  Session,
  type SessionResult,
  type Snapshot,
  type TerminalReason,
} from "@clockwork2/kernel"
import { browserScheduler, type Scheduler } from "./clock"

export type HostState = "idle" | "running" | "paused" | "ended"

export interface GameHostOptions<
  TView = unknown,
  TContainer = unknown,
  TConfig = PlainValue,
> {
  readonly module: GameModule<TView, TConfig>
  readonly manifest: Manifest
  readonly seed: string
  readonly config?: TConfig
  readonly presentation?: Presentation<TView, TContainer>
  readonly container?: TContainer
  readonly scheduler?: Scheduler
  /** Ticks between state hashes. Defaults to one second of play. */
  readonly checkpointEvery?: number
  /**
   * A cap below the manifest's.
   *
   * Replaying a recording that was abandoned mid-run needs one: the log ends
   * where the player stopped, and without a cap the replay carries on past it
   * and reports a different end tick for a session that did not diverge.
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
}

export interface FrameInfo {
  readonly tick: number
  readonly ticksThisFrame: number
  readonly alpha: number
  readonly elapsedMs: number
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
  private ticksRun = 0
  private speed: number

  constructor(
    private readonly options: GameHostOptions<TView, TContainer, TConfig>,
  ) {
    this.scheduler = options.scheduler ?? browserScheduler()
    this.accumulator = new Accumulator({
      tickHz: options.manifest.session.tickHz,
    })
    this.speed = options.speed ?? 1
    if (options.inputs === undefined) {
      const queue = new LiveInputQueue()
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
      config: (this.options.config ?? {}) as TConfig,
      inputs: this.source,
      maxTicks: this.options.maxTicks ?? this.options.manifest.session.maxTicks,
      checkpointEvery:
        this.options.checkpointEvery ?? this.options.manifest.session.tickHz,
      counters: this.options.manifest.counters,
      ...(this.options.onCheckpoint === undefined
        ? {}
        : { onCheckpoint: this.options.onCheckpoint }),
      ...(this.options.onEffects === undefined
        ? {}
        : { onEffects: this.options.onEffects }),
      ...(this.options.resumeFrom === undefined
        ? {}
        : { resumeFrom: this.options.resumeFrom }),
    })
  }

  get tick(): number {
    return this.session.tick
  }

  get status(): HostState {
    return this.state
  }

  get stats(): LoopStats {
    const accumulator = this.accumulator.stats
    return {
      frames: accumulator.frames,
      ticksRun: this.ticksRun,
      mostTicksInAFrame: accumulator.mostTicksInAFrame,
      droppedMs: accumulator.droppedMs,
    }
  }

  /** How far between the last tick and the next, for the renderer. */
  get alpha(): number {
    return this.accumulator.alpha
  }

  setSpeed(speed: number): void {
    if (!Number.isFinite(speed) || speed <= 0) {
      throw new RangeError(`speed must be a positive number, got ${speed}`)
    }
    // Replay speed belongs here rather than in the renderer. Clockwork 1 set
    // it on PIXI's ticker, which made how fast the game ran a property of the
    // thing drawing it.
    this.speed = speed
  }

  private mount(): void {
    const { presentation, container } = this.options
    if (presentation === undefined || container === undefined || this.mounted)
      return
    presentation.mount(
      container,
      this.options.presentationContext ?? {
        random: () => 0.5,
        assets: new Map(),
        devicePixelRatio: 1,
        theme: "light",
      },
    )
    this.mounted = true
  }

  start(): void {
    if (this.state === "running") return
    this.mount()
    this.state = "running"
    this.lastNow = this.scheduler.now()
    this.schedule()
  }

  pause(): void {
    if (this.state !== "running") return
    this.state = "paused"
    this.unschedule()
  }

  resume(): void {
    if (this.state !== "paused") return
    this.state = "running"
    // The clock restarts here rather than carrying the pause forward, so a
    // paused tab does not come back owing four minutes of simulation.
    this.lastNow = this.scheduler.now()
    this.schedule()
  }

  /** Ends the session without finishing it, for a player who walked away. */
  stop(reason: TerminalReason = "abandoned"): void {
    if (this.state === "ended") return
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

  private frame(now: number): void {
    if (this.state !== "running") return
    const elapsed = (now - this.lastNow) * this.speed
    this.lastNow = now

    let ticksThisFrame = 0
    try {
      const steps = this.accumulator.frame(elapsed)
      for (let i = 0; i < steps; i++) {
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
      this.unschedule()
      this.state = "ended"
      this.options.onError?.(error)
      return
    }

    this.render(elapsed)
    this.options.onFrame?.({
      tick: this.session.tick,
      ticksThisFrame,
      alpha: this.accumulator.alpha,
      elapsedMs: elapsed,
    })
    this.schedule()
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
    this.unschedule()
    this.state = "ended"
    this.render(0)
    this.options.onEnded?.(this.session.result())
  }

  /** Runs one tick by hand, for a test that wants no frame pacing at all. */
  stepOnce(): boolean {
    const running = this.session.step()
    this.ticksRun++
    if (!running) {
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
      config: (this.options.config ?? {}) as PlainValue,
      inputs,
      checkpoints: result.checkpoints,
      endTick: result.endTick,
      terminal: result.terminal,
      counters: result.counters,
    }
  }

  destroy(): void {
    this.unschedule()
    const { presentation } = this.options
    if (presentation !== undefined && this.mounted) {
      presentation.unmount()
      this.mounted = false
    }
    this.state = "ended"
  }
}
