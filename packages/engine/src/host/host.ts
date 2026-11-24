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
  DEFAULT_MAX_CATCHUP_TICKS,
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
  type RemoteInputFeed,
  Session,
  type SessionResult,
  type Snapshot,
  seatsOf,
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

/**
 * A live session of a game whose manifest declares more than one seat: which
 * seat this page plays, and where every other seat's inputs come from.
 */
export interface SeatOptions {
  /**
   * The seat this page plays, from 0 to one below the manifest's
   * `session.seats`, or null for a page that only watches. A watching page
   * has no live queue and reads every tick from `remote`.
   */
  readonly local: number | null
  /**
   * The inputs of every seat this page does not play, as they arrive. On a
   * tick that is another seat's turn the loop holds, as it holds for a
   * missing pack, until the feed is confirmed through that tick. It carries
   * no input for a tick of the local seat's turn.
   */
  readonly remote: RemoteInputFeed
  /**
   * Called after each frame that ran a tick, for a page that plays a seat:
   * the local seat's inputs recorded since the last call, and the last tick
   * this page has run. That tick is final for the local seat, whoever's turn
   * it was, because the local seat records nothing on another seat's ticks.
   * The page sends both to the other seats' pages, which `append` the inputs
   * to their feed and `confirm` the tick.
   */
  readonly onLocalInputs?: (
    events: readonly InputEvent[],
    throughTick: number,
  ) => void
}

export interface GameHostOptions<
  TView = unknown,
  TContainer = unknown,
  TConfig = PlainValue,
> {
  readonly module: GameModule<TView, TConfig>
  readonly manifest: Manifest
  readonly seed: string
  /**
   * The config the session plays. Left out of a live session, it is
   * `servedConfig(manifest)`, every declared parameter at its default, which
   * is what a platform serves a ranked or practice run and what the
   * conformance checks play. A replay, given `inputs`, must pass the
   * recording's own config, because that is what the run it replays played.
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
  /**
   * Required for a live session of a game whose manifest declares more than
   * one seat, and refused for any other. A replay of such a game takes the
   * recording's merged log as `inputs` instead, as any replay does.
   */
  readonly seats?: SeatOptions
}

export interface FrameInfo {
  readonly tick: number
  readonly ticksThisFrame: number
  readonly alpha: number
  readonly elapsedMs: number
  /** The packs the loop is holding for. Empty while it runs. */
  readonly waitingFor: readonly string[]
  /**
   * The seat the loop is holding for: its turn has come and its inputs for
   * the next tick are not confirmed yet. Null while it runs.
   */
  readonly waitingForSeat: number | null
}

export interface LoopStats {
  readonly frames: number
  readonly ticksRun: number
  readonly mostTicksInAFrame: number
  readonly droppedMs: number
}

/**
 * Where a seated session's ticks read: the live queue on the local seat's
 * turn, the remote feed on every other. It keeps the merged log, which is
 * the recording, and the local inputs not yet handed to `onLocalInputs`.
 */
class TurnInputs implements InputSource {
  private readonly log: InputEvent[] = []
  private readonly unsent: InputEvent[] = []

  constructor(
    private readonly live: LiveInputQueue | null,
    private readonly local: number | null,
    private readonly remote: RemoteInputFeed,
  ) {}

  take(tick: number, seat: number): readonly InputEvent[] {
    const mine = this.live !== null && seat === this.local
    const events = mine
      ? (this.live as LiveInputQueue).take(tick)
      : this.remote.take(tick)
    for (const event of events) {
      this.log.push(event)
      if (mine) this.unsent.push(event)
    }
    return events
  }

  seek(tick: number): void {
    this.remote.seek(tick)
  }

  recorded(): readonly InputEvent[] {
    return this.log
  }

  /** The local inputs recorded since the last call. */
  drainLocal(): readonly InputEvent[] {
    return this.unsent.splice(0)
  }
}

export class GameHost<
  TView = unknown,
  TContainer = unknown,
  TConfig = PlainValue,
> {
  /**
   * Present only for a live session that plays a seat; a replay reads its
   * recorded source and a watching page its remote feed.
   */
  readonly live: LiveInputQueue | null
  private readonly source: InputSource
  /** A seated session's inputs, or null for a session without seats. */
  private readonly turns: TurnInputs | null
  /** Whether the live queue is paused because another seat's turn began. */
  private turnHeld = false
  /** The last tick handed to `onLocalInputs`. */
  private sentThrough = -1
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
  /** `pause` was called while `prepare` ran: the host is paused when it is ready. */
  private pauseWhenReady = false
  /**
   * Whether the live queue is paused because this host paused it. The host
   * resumes only that: a queue the page paused itself stays paused.
   */
  private holdingQueue = false
  /** What the presentation is mounted and prepared with: one object for both. */
  private readonly context: PresentationContext
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
    if (options.inputs !== undefined && options.config === undefined) {
      fail("E_ARG_INVALID", {
        detail:
          "config is required for a replay: pass the recording's config, which is what the run it replays played",
      })
    }
    const seats = seatsOf(options.manifest)
    const seated = options.seats
    if (seated !== undefined) {
      if (seats === 1) {
        fail("E_ARG_INVALID", {
          detail:
            "seats is for a game whose manifest declares more than one seat, and this one declares one",
        })
      }
      if (options.inputs !== undefined) {
        fail("E_ARG_INVALID", {
          detail:
            "a replay reads the recording's merged log as inputs and takes no seats",
        })
      }
      const local = seated.local
      if (
        local !== null &&
        (!Number.isInteger(local) || local < 0 || local >= seats)
      ) {
        fail("E_ARG_INVALID", {
          detail: `seats.local must be null or a seat from 0 to ${seats - 1}, got ${String(local)}`,
        })
      }
    } else if (seats > 1 && options.inputs === undefined) {
      fail("E_ARG_INVALID", {
        detail: `the manifest declares ${seats} seats, so a live session needs seats: the seat this page plays and a feed for the others`,
      })
    }
    this.config =
      options.config ?? (servedConfig(options.manifest) as unknown as TConfig)
    this.context = options.presentationContext ?? {
      random: () => 0.5,
      assets: new Map(),
      devicePixelRatio: 1,
      theme: "light",
    }
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
    if (options.inputs !== undefined) {
      this.live = null
      this.turns = null
      this.source = options.inputs
    } else if (seated !== undefined) {
      this.live =
        seated.local === null
          ? null
          : new LiveInputQueue(options.manifest.inputs)
      this.turns = new TurnInputs(this.live, seated.local, seated.remote)
      this.source = this.turns
    } else {
      const queue = new LiveInputQueue(options.manifest.inputs)
      this.live = queue
      this.turns = null
      this.source = queue
    }
    this.session = this.createSession()
    // On another seat's turn the queue takes nothing, from before tick 0 on.
    this.syncTurn()
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
      seats: seatsOf(this.options.manifest),
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

  /** The seat whose inputs the next tick reads, from the game's `seat()`. */
  get seat(): number {
    return this.session.seat
  }

  /**
   * What the loop did. `droppedMs` counts the time it held for a pack as well
   * as the time it dropped, because both are real time that produced no
   * ticks, and a platform deciding whether a run was slow needs to see both.
   * Time spent waiting for another seat's turn is not in it: in a game of
   * turns that is most of a run, and it says nothing about this device.
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

  /**
   * The seat the loop is holding for right now: its turn has come and the
   * remote feed is not confirmed through the next tick. Null otherwise.
   */
  get waitingForSeat(): number | null {
    const seated = this.options.seats
    if (seated === undefined || !this.session.running) return null
    const seat = this.session.seat
    if (seat === seated.local) return null
    return seated.remote.confirmedThrough >= this.session.tick ? null : seat
  }

  /**
   * Whether the next tick is another seat's and its inputs are already
   * confirmed, so a page following the run may run it ahead of its clock.
   */
  private get canFollow(): boolean {
    const seated = this.options.seats
    return (
      seated !== undefined &&
      this.session.running &&
      this.session.seat !== seated.local &&
      seated.remote.confirmedThrough >= this.session.tick
    )
  }

  /**
   * Keeps the live queue taking input exactly while the next tick is the
   * local seat's. At the end of the local seat's turn the queue drops what
   * the helpers release and whatever is pending, so nothing it records lands
   * on another seat's tick; at the start of the next it takes input again,
   * unless the page or a pause of this host paused it.
   */
  private syncTurn(): void {
    const seated = this.options.seats
    const live = this.live
    if (seated === undefined || live === null) return
    if (this.session.seat !== seated.local) {
      if (this.turnHeld) return
      const pausedBefore = live.paused
      live.endTurn()
      this.turnHeld = !pausedBefore
    } else if (this.turnHeld) {
      this.turnHeld = false
      if (!this.holdingQueue) live.resume()
    }
  }

  /** Hands the page the local inputs since the last call, after a frame. */
  private sendLocal(): void {
    const seated = this.options.seats
    const turns = this.turns
    if (
      seated?.onLocalInputs === undefined ||
      seated.local === null ||
      turns === null
    ) {
      return
    }
    const through = this.session.tick - 1
    if (through <= this.sentThrough) return
    this.sentThrough = through
    seated.onLocalInputs(turns.drainLocal(), through)
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
   * the player does before the game can draw is recorded. A `pause` while it
   * waits is kept: the host is then `"paused"` when `prepare` resolves, and
   * `resume` starts the clock. A presentation without `prepare`, or no
   * presentation, starts the clock before `start` returns, as it always has.
   * On a paused host `start` does what `resume` does.
   *
   * @returns whether the host is ready: true once the clock is running, or
   *   paused because `pause` was called while `prepare` ran; false when it
   *   never will be, because the session has ended, `prepare` rejected
   *   (reported through `onError` as `E_PRESENTATION_FAILED`), or the host
   *   was stopped or destroyed while `prepare` ran. It never rejects, so a
   *   caller with nothing to wait for may leave it.
   */
  start(): Promise<boolean> {
    if (this.state === "running") return Promise.resolve(true)
    if (this.state === "paused") {
      this.resume()
      return Promise.resolve(true)
    }
    // A finished session does not restart. Without this, start() on an ended
    // host schedules a frame, session.step() returns false immediately, and
    // finish() fires onEnded a second time - so a host bridge sends a second
    // `ended` and a second recording for one run. A shell that starts twice,
    // which a re-rendering effect does by itself, is enough to trigger it.
    if (this.state === "ended") return Promise.resolve(false)
    if (this.preparing !== null) return this.preparing
    this.mount()
    const { presentation, container } = this.options
    if (
      !this.mounted ||
      presentation?.prepare === undefined ||
      container === undefined
    ) {
      this.run()
      return Promise.resolve(true)
    }
    this.state = "preparing"
    this.holdQueue()
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
        if (this.pauseWhenReady) {
          // Paused while it waited, as a page put in the background is: the
          // queue stays held, and resume starts the clock.
          this.pauseWhenReady = false
          this.state = "paused"
          return true
        }
        this.releaseQueue()
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

  /** Pauses the live queue, unless something else already has. */
  private holdQueue(): void {
    const live = this.live
    if (live === null || live.paused || this.holdingQueue) return
    live.pause()
    this.holdingQueue = true
  }

  /**
   * Resumes the live queue if this host was the one that paused it, unless
   * another seat's turn is holding it.
   */
  private releaseQueue(): void {
    if (!this.holdingQueue) return
    this.holdingQueue = false
    if (!this.turnHeld) this.live?.resume()
  }

  /** Starts the clock now. */
  private run(): void {
    this.state = "running"
    this.lastNow = this.scheduler.now()
    this.schedule()
  }

  /**
   * Pauses the clock. While `prepare` runs it is remembered, and the host is
   * paused rather than running once the presentation is ready.
   */
  pause(): void {
    if (this.state === "preparing") {
      this.pauseWhenReady = true
      return
    }
    if (this.state !== "running") return
    this.state = "paused"
    this.unschedule()
    // Whatever the player holds is released into the log, and nothing more
    // is taken until the run resumes.
    this.holdQueue()
  }

  /** Resumes a paused clock; while `prepare` runs, takes back a `pause`. */
  resume(): void {
    if (this.state === "preparing") {
      this.pauseWhenReady = false
      return
    }
    if (this.state !== "paused") return
    this.state = "running"
    this.releaseQueue()
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
   * Holds the loop for packs the next tick needs, or for another seat's
   * inputs.
   *
   * The time is not fed to the accumulator, so nothing is banked and no burst
   * of ticks follows the arrival. Time held for a pack is counted in
   * `droppedMs`; time held for a seat is not.
   */
  private hold(missing: readonly string[], ms: number): void {
    if (missing.length === 0) return
    this.heldMs += ms
    for (const path of missing) this.requests.request(path, true)
  }

  /** Whether the next tick cannot run yet: a pack or a seat's inputs. */
  private held(): readonly string[] | null {
    const missing = this.session.packsMissing()
    return missing.length > 0 || this.waitingForSeat !== null ? missing : null
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
    const waiting = this.held()
    if (waiting !== null) {
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
      // The ticks the clock owes run first. Past them, a page following
      // another seat's turn runs the ticks its feed has confirmed, up to the
      // catch-up limit, so one that fell behind the sender gains on it.
      while (
        ticksThisFrame < steps ||
        (ticksThisFrame < DEFAULT_MAX_CATCHUP_TICKS && this.canFollow)
      ) {
        const missing = this.held()
        if (missing !== null) {
          // The accumulator already took this frame's time for the steps
          // that will not run now.
          this.hold(
            missing,
            Math.max(steps - ticksThisFrame, 0) * this.accumulator.stepMs,
          )
          if (this.state !== "running") return
          break
        }
        this.syncTurn()
        const previous = this.options.module.view()
        const running = this.session.step()
        ticksThisFrame++
        this.ticksRun++
        this.previousView = previous
        if (!running) {
          this.sendLocal()
          this.finish()
          return
        }
        this.syncTurn()
      }
      this.sendLocal()
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
      waitingForSeat: this.waitingForSeat,
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
    this.syncTurn()
    const running = this.session.step()
    this.ticksRun++
    this.syncTurn()
    this.sendLocal()
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
   * rather than an empty one; `recordingFrom` is how a caller passes it. A
   * seated session records the merged log: every input every tick took, the
   * local seat's and the feed's, which replays through a
   * `RecordedInputSource` to the same checkpoints.
   */
  recording(
    inputs: readonly InputEvent[] = this.turns?.recorded() ??
      this.live?.recorded() ??
      [],
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
