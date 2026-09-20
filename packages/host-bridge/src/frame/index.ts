/**
 * The game's half, running inside the sandboxed frame.
 *
 * It checks `event.origin` against the platform's origin on every inbound
 * message. The parent cannot do the same in reverse, because the frame is in
 * an opaque origin and reports "null"; it checks the window identity instead.
 * Between them the two halves know who they are talking to.
 */

import type { Counters, SessionResult } from "@clockwork2/kernel"
import {
  encodeRecording,
  hashCanonical,
  KERNEL_VERSION,
} from "@clockwork2/kernel"
import type { GameHost } from "../host"
import {
  createDispatcher,
  type GameToHost,
  type HostToGame,
  PROGRESS_INTERVAL_MS,
  PROTOCOL_VERSION,
} from "../protocol/index"

export interface FrameBridgeOptions<TView> {
  readonly host: GameHost<TView, HTMLElement>
  /** The platform origin this frame will talk to, and no other. */
  readonly parentOrigin: string
  /** Splitting the recording keeps one postMessage from being enormous. */
  readonly chunkSize?: number
  readonly onResize?: (
    width: number,
    height: number,
    devicePixelRatio: number,
  ) => void
  readonly onTheme?: (theme: string) => void
}

const DEFAULT_CHUNK = 48 * 1024

export class FrameBridge<TView> {
  private readonly onMessage: (event: MessageEvent) => void
  private lastProgressAt = 0

  constructor(private readonly options: FrameBridgeOptions<TView>) {
    const { host } = options
    const dispatch = createDispatcher<HostToGame>({
      hello: () => {
        this.post({
          type: "ready",
          protocol: PROTOCOL_VERSION,
          manifestHash: hashCanonical(
            (host as unknown as { options: { manifest: unknown } }).options
              .manifest as never,
          ),
          kernelVersion: KERNEL_VERSION,
        })
      },
      init: () => {
        // The host is built with its seed and config already; `init` exists so
        // a frame that was loaded before the session was decided can wait.
      },
      start: () => {
        host.start()
        this.post({ type: "started" })
      },
      pause: () => {
        host.pause()
      },
      resume: () => {
        host.resume()
      },
      end: () => {
        host.stop()
      },
      resize: (message) => {
        options.onResize?.(
          message.width,
          message.height,
          message.devicePixelRatio,
        )
      },
      theme: (message) => {
        options.onTheme?.(message.theme)
      },
      "virtual-input": (message) => {
        // The only place a virtual input may enter a session.
        host.live?.push({
          device: "virtual",
          code: message.action,
          value: message.value,
        })
      },
    })

    this.onMessage = (event: MessageEvent): void => {
      if (event.origin !== options.parentOrigin) return
      dispatch(event.data)
    }
    globalThis.addEventListener("message", this.onMessage)
  }

  private post(message: GameToHost): void {
    globalThis.parent.postMessage(message, this.options.parentOrigin)
  }

  /** Call from the host's onCheckpoint. */
  checkpoint(tick: number, hash: string): void {
    this.post({ type: "checkpoint", tick, hash })
  }

  /** Call from the host's onFrame. Rate-limited, so it cannot flood. */
  progress(tick: number, counters: Counters, now: number): void {
    if (now - this.lastProgressAt < PROGRESS_INTERVAL_MS) return
    this.lastProgressAt = now
    this.post({ type: "progress", tick, counters })
  }

  heartbeat(tick: number): void {
    this.post({ type: "heartbeat", tick })
  }

  /** Call from the host's onEnded. Sends the result, then the recording. */
  ended(result: SessionResult, recording: string): void {
    this.post({
      type: "ended",
      tick: result.endTick,
      counters: result.counters,
      reason: result.terminal,
      finalSnapshot: result.snapshot,
    })
    const size = this.options.chunkSize ?? DEFAULT_CHUNK
    const total = Math.max(1, Math.ceil(recording.length / size))
    for (let index = 0; index < total; index++) {
      this.post({
        type: "recording-chunk",
        index,
        total,
        data: recording.slice(index * size, (index + 1) * size),
      })
    }
  }

  error(code: string, detail: string): void {
    this.post({ type: "error", code, detail })
  }

  destroy(): void {
    globalThis.removeEventListener("message", this.onMessage)
  }
}

/** Wires a host to a parent, including the callbacks it needs. */
export function connectToParent<TView>(
  options: FrameBridgeOptions<TView>,
): FrameBridge<TView> {
  const bridge = new FrameBridge(options)
  return bridge
}

export { encodeRecording }
