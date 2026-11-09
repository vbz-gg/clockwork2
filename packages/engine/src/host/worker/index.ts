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
  PackBytes,
  PlainValue,
  SessionResult,
  Snapshot,
} from "../../index.js"
import {
  Accumulator,
  type Effect,
  isClockworkError,
  LiveInputQueue,
  PackSet,
  Session,
} from "../../index.js"
import { ownedBuffer, PackRequests, type PackSupply } from "../packs.js"

/**
 * One pack on its way to the worker. The buffer is transferred, so the page
 * sends a copy it made for the purpose and keeps nothing of it.
 */
export type PackTransfer = {
  readonly path: string
  readonly bytes: ArrayBuffer
}

export type ToWorker =
  | {
      readonly type: "init"
      readonly seed: string
      readonly config: PlainValue
      /** Every start pack, and any demand pack the page already has. */
      readonly packs?: readonly PackTransfer[]
    }
  | { readonly type: "packs"; readonly packs: readonly PackTransfer[] }
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
  | {
      /** The loop is holding for these. The page fetches and sends them. */
      readonly type: "packs-needed"
      readonly paths: readonly string[]
    }
  | {
      readonly type: "error"
      readonly detail: string
      /** The kernel's code, when the failure carried one. */
      readonly code?: string
    }

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
  let failed = false
  /** The missing set last asked for, so a held loop asks once, not per frame. */
  let asked = ""
  const queue = new LiveInputQueue()
  const accumulator = new Accumulator({ tickHz: manifest.session.tickHz })

  const askFor = (missing: readonly string[]): void => {
    const key = missing.join("\n")
    if (key === asked) return
    asked = key
    if (missing.length > 0)
      scope.postMessage({ type: "packs-needed", paths: missing })
  }

  scope.addEventListener("message", (event: { readonly data: unknown }) => {
    const message = event.data as ToWorker
    // A session that failed stays failed. Stepping it again after a throw
    // would run a tick on whatever state the throw left behind.
    if (failed) return
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
            assets: manifest.assets ?? [],
            packs: PackSet.verify(
              manifest.assets,
              (message.packs ?? []).map((pack) => [pack.path, pack.bytes]),
            ),
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
        case "packs": {
          if (session === null) return
          for (const pack of message.packs) {
            try {
              session.deliver(pack.path, pack.bytes)
            } catch (error) {
              // Bad bytes for a pack nothing has named yet, which a prefetch
              // fetched, are forgotten, as the page's host forgets them. The
              // page fetches the pack again when the game names it, and if
              // the bytes are still bad they are refused then.
              if (session.packsMissing().includes(pack.path)) throw error
            }
          }
          return
        }
        case "frame": {
          if (session === null || module === null) return
          let running = true
          // Held, the frame's time is not fed to the accumulator, so no burst
          // of ticks follows the pack's arrival. The frame is still answered,
          // or the page would never send another and the hold never end.
          let missing = session.packsMissing()
          if (missing.length === 0) {
            // Whatever the loop last held for has arrived. If it is dropped
            // and named again later, that is a new hold with a new request.
            asked = ""
            const steps = accumulator.frame(message.elapsedMs)
            for (let i = 0; i < steps && running; i++) {
              missing = session.packsMissing()
              if (missing.length > 0) break
              running = session.step()
            }
          }
          askFor(missing)
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
      failed = true
      session?.abandon("error")
      scope.postMessage({
        type: "error",
        detail: String(error),
        ...(isClockworkError(error) ? { code: error.code } : {}),
      })
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
  /** `code` is the kernel's, when the failure carried one. */
  readonly onError?: (detail: string, code?: string) => void
  /**
   * The data packs. Start packs must be preloaded: they go to the worker with
   * `init`. Demand packs come from the loader when the game hints at them or
   * the worker holds for them.
   */
  readonly packs?: PackSupply
}

/** The page side. */
export class WorkerSimulation {
  private frameId = 0
  private outstanding = false
  private carried = 0
  private ready = false
  private readonly requests: PackRequests
  /** Packs sent to the worker, so a repeated hint does not send them again. */
  private readonly sent = new Set<string>()

  constructor(private readonly options: WorkerSimulationOptions) {
    this.requests = new PackRequests(
      options.packs?.loader,
      (path, bytes) => {
        this.sent.add(path)
        this.sendPacks([[path, bytes]])
      },
      (error) => {
        this.requests.close()
        options.onError?.(
          String(error),
          ...(isClockworkError(error) ? [error.code] : []),
        )
      },
      (path) => this.sent.has(path),
    )
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
          this.requests.prefetch(message.effects as readonly Effect[])
          options.onEffects?.(message.effects, message.tick)
          break
        case "packs-needed":
          // The worker does not have these, whatever was sent before: it
          // dropped them when the game stopped naming them.
          for (const path of message.paths) {
            this.sent.delete(path)
            this.requests.request(path, true)
          }
          break
        case "ended":
          this.requests.close()
          options.onEnded?.({
            endTick: message.result.endTick,
            counters: message.result.counters,
            snapshot: message.result.snapshot,
            terminal: message.result.terminal,
            inputs: message.inputs,
          })
          break
        default:
          this.requests.close()
          options.onError?.(
            message.detail,
            ...(message.code === undefined ? [] : [message.code]),
          )
      }
    })
    const packs = [...(options.packs?.preloaded ?? [])].map(
      ([path, bytes]): PackTransfer => {
        this.sent.add(path)
        return { path, bytes: ownedBuffer(bytes) }
      },
    )
    options.worker.postMessage(
      {
        type: "init",
        seed: options.seed,
        config: options.config ?? {},
        packs,
      } satisfies ToWorker,
      packs.map((pack) => pack.bytes),
    )
  }

  private sendPacks(
    entries: ReadonlyArray<readonly [string, PackBytes]>,
  ): void {
    const packs = entries.map(
      ([path, bytes]): PackTransfer => ({ path, bytes: ownedBuffer(bytes) }),
    )
    this.options.worker.postMessage(
      { type: "packs", packs } satisfies ToWorker,
      packs.map((pack) => pack.bytes),
    )
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
    this.requests.close()
    this.options.worker.postMessage({ type: "stop" } satisfies ToWorker)
  }

  terminate(): void {
    this.requests.close()
    this.options.worker.terminate()
  }
}
