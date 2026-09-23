/**
 * Running the simulation in a worker.
 *
 * The clock stays on the page, because that is where `requestAnimationFrame`
 * is; the simulation moves off it. Each frame the page sends the elapsed time,
 * the worker turns it into whole ticks and sends back a view to draw. The
 * renderer therefore physically holds a copy of the state rather than a
 * reference to it, which is the strongest form of "the renderer cannot write
 * to the simulation" there is.
 *
 * Backpressure: one frame may be outstanding. A newer one replaces an older
 * one that has not been sent, so a page that falls behind skips frames instead
 * of building a queue of stale ones.
 *
 * `view()` must therefore return structured-cloneable data. That is the one
 * rule a game has to follow to work in both modes, and it is worth following
 * anyway: a view full of class instances cannot be sent anywhere.
 */

import type {
  Counters,
  GameModule,
  InputEvent,
  Manifest,
  PlainValue,
  SessionResult,
  Snapshot,
} from "../../index.js"
import { Accumulator, LiveInputQueue, Session } from "../../index.js"

export type ToWorker =
  | {
      readonly type: "init"
      readonly seed: string
      readonly config: PlainValue
    }
  | {
      readonly type: "input"
      readonly inputs: readonly Omit<InputEvent, "tick">[]
    }
  | {
      readonly type: "frame"
      readonly elapsedMs: number
      readonly frameId: number
    }
  | { readonly type: "stop" }

export type FromWorker =
  | { readonly type: "ready" }
  | {
      readonly type: "frame"
      readonly frameId: number
      readonly tick: number
      readonly alpha: number
      readonly view: unknown
      readonly running: boolean
    }
  | {
      readonly type: "checkpoint"
      readonly tick: number
      readonly hash: string
    }
  | {
      readonly type: "effects"
      readonly effects: unknown
      readonly tick: number
    }
  | {
      readonly type: "ended"
      readonly result: {
        readonly endTick: number
        readonly terminal: string
        readonly counters: Counters
        readonly snapshot: Snapshot
      }
      readonly inputs: readonly InputEvent[]
    }
  | { readonly type: "error"; readonly detail: string }

/**
 * The least a worker scope has to provide. Narrower than `DedicatedWorkerGlobalScope`
 * on purpose, so a test can stand in for one without inventing a MessageEvent.
 */
export interface WorkerScope {
  postMessage: (message: FromWorker) => void
  addEventListener: (
    type: "message",
    listener: (event: { readonly data: unknown }) => void,
  ) => void
}

/**
 * The worker side. A game's worker entry is three lines:
 *
 * ```ts
 * import { runSimulationWorker } from "./index.js"
 * import { createGame, MANIFEST } from "./game.js"
 * runSimulationWorker(createGame, MANIFEST)
 * ```
 */
export function runSimulationWorker(
  create: () => GameModule,
  manifest: Manifest,
  scope: WorkerScope = globalThis as unknown as WorkerScope,
): void {
  let session: Session | null = null
  let module: GameModule | null = null
  const queue = new LiveInputQueue()
  const accumulator = new Accumulator({ tickHz: manifest.session.tickHz })

  scope.addEventListener("message", (event: { readonly data: unknown }) => {
    const message = event.data as ToWorker
    try {
      switch (message.type) {
        case "init": {
          module = create()
          session = new Session({
            module,
            seed: message.seed,
            config: message.config,
            inputs: queue,
            maxTicks: manifest.session.maxTicks,
            checkpointEvery: manifest.session.tickHz,
            counters: manifest.counters,
            onCheckpoint: (checkpoint) => {
              scope.postMessage({ type: "checkpoint", ...checkpoint })
            },
            onEffects: (effects, tick) => {
              scope.postMessage({
                type: "effects",
                effects: effects as unknown,
                tick,
              })
            },
          })
          scope.postMessage({ type: "ready" })
          return
        }
        case "input": {
          for (const input of message.inputs) queue.push(input)
          return
        }
        case "frame": {
          if (session === null || module === null) return
          const steps = accumulator.frame(message.elapsedMs)
          let running = true
          for (let i = 0; i < steps && running; i++) running = session.step()
          scope.postMessage({
            type: "frame",
            frameId: message.frameId,
            tick: session.tick,
            alpha: accumulator.alpha,
            view: module.view() as unknown,
            running,
          })
          if (!running) {
            const result = session.result()
            scope.postMessage({
              type: "ended",
              result: {
                endTick: result.endTick,
                terminal: result.terminal,
                counters: result.counters,
                snapshot: result.snapshot,
              },
              inputs: queue.recorded(),
            })
          }
          return
        }
        default: {
          if (session !== null) session.abandon()
          return
        }
      }
    } catch (error) {
      scope.postMessage({ type: "error", detail: String(error) })
    }
  })
}

export interface WorkerSimulationOptions {
  /** The caller owns the Worker, so the bundler resolves its URL, not us. */
  readonly worker: Worker
  readonly seed: string
  readonly config?: PlainValue
  readonly onFrame?: (frame: {
    tick: number
    alpha: number
    view: unknown
    running: boolean
  }) => void
  readonly onCheckpoint?: (checkpoint: { tick: number; hash: string }) => void
  readonly onEffects?: (effects: unknown, tick: number) => void
  readonly onEnded?: (
    result: Pick<SessionResult, "endTick" | "counters" | "snapshot"> & {
      terminal: string
      inputs: readonly InputEvent[]
    },
  ) => void
  readonly onError?: (detail: string) => void
}

/** The page side. */
export class WorkerSimulation {
  private frameId = 0
  private outstanding = false
  private carried = 0
  private ready = false

  constructor(private readonly options: WorkerSimulationOptions) {
    options.worker.addEventListener("message", (event: MessageEvent) => {
      const message = event.data as FromWorker
      switch (message.type) {
        case "ready":
          this.ready = true
          break
        case "frame":
          this.outstanding = false
          options.onFrame?.({
            tick: message.tick,
            alpha: message.alpha,
            view: message.view,
            running: message.running,
          })
          break
        case "checkpoint":
          // Without stripping the discriminant the caller receives the wire
          // message rather than the checkpoint, which then fails to compare
          // equal to one the kernel produced.
          options.onCheckpoint?.({ tick: message.tick, hash: message.hash })
          break
        case "effects":
          options.onEffects?.(message.effects, message.tick)
          break
        case "ended":
          options.onEnded?.({
            endTick: message.result.endTick,
            counters: message.result.counters,
            snapshot: message.result.snapshot,
            terminal: message.result.terminal,
            inputs: message.inputs,
          })
          break
        default:
          options.onError?.(message.detail)
      }
    })
    options.worker.postMessage({
      type: "init",
      seed: options.seed,
      config: options.config ?? {},
    } satisfies ToWorker)
  }

  send(inputs: readonly Omit<InputEvent, "tick">[]): void {
    if (inputs.length === 0) return
    this.options.worker.postMessage({
      type: "input",
      inputs,
    } satisfies ToWorker)
  }

  /**
   * Offers a frame's elapsed time.
   *
   * While one frame is outstanding the time is carried rather than queued, so
   * no simulation time is lost and no stale frame is ever sent.
   */
  frame(elapsedMs: number): void {
    if (!this.ready) {
      this.carried += elapsedMs
      return
    }
    this.carried += elapsedMs
    if (this.outstanding) return
    const total = this.carried
    this.carried = 0
    this.outstanding = true
    this.options.worker.postMessage({
      type: "frame",
      elapsedMs: total,
      frameId: this.frameId++,
    } satisfies ToWorker)
  }

  stop(): void {
    this.options.worker.postMessage({ type: "stop" } satisfies ToWorker)
  }

  terminate(): void {
    this.options.worker.terminate()
  }
}
