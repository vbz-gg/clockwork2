/**
 * The game's half, running inside the sandboxed frame.
 *
 * It checks `event.origin` against the platform's origin on every inbound
 * message. The parent cannot do the same in reverse, because the frame is in
 * an opaque origin and reports "null"; it checks the window identity instead.
 * Between them the two halves know who they are talking to.
 *
 * The frame document loads before the platform has decided anything about the
 * session, so the bridge starts with no host at all and builds one when `init`
 * arrives with the seed. That ordering is the reason the seed never has to
 * travel in the frame's URL, where it would end up in a referrer, a history
 * entry and a server log.
 */

import type {
  Counters,
  Manifest,
  SessionResult,
  TickRate,
} from "@clockwork2/kernel"
import {
  encodeRecording,
  hashCanonical,
  KERNEL_VERSION,
} from "@clockwork2/kernel"
import type { GameHost } from "../host"
import {
  createDispatcher,
  FRAME_ERRORS,
  type GameToHost,
  type HostToGame,
  LOG_CHUNK_INTERVAL_MS,
  PROGRESS_INTERVAL_MS,
  PROTOCOL_VERSION,
} from "../protocol/index"

/** What the parent decided about this session, as `init` delivers it. */
export interface FrameInit {
  readonly seed: string
  readonly config: unknown
  readonly tickHz: TickRate
  readonly maxTicks: number
}

export interface FrameBridgeOptions<TView> {
  /**
   * Builds the session once the parent says what it is.
   *
   * Called at most once, from the `init` handler, with the bridge so the host's
   * callbacks can post back through it. Anything it throws is reported to the
   * parent as an error rather than left to a console nobody is reading.
   */
  readonly createHost: (
    init: FrameInit,
    bridge: FrameBridge<TView>,
  ) => GameHost<TView, HTMLElement>
  /**
   * Read for the hash in `ready`, which the parent compares against the
   * version it pinned. It is needed before a host exists, so it is given here
   * rather than taken off one.
   */
  readonly manifest: Manifest
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
  private host: GameHost<TView, HTMLElement> | null = null
  private lastProgressAt = 0
  private lastLogChunkAt = 0
  private logSentUpTo = 0

  constructor(private readonly options: FrameBridgeOptions<TView>) {
    const dispatch = createDispatcher<HostToGame>({
      hello: () => {
        this.post({
          type: "ready",
          protocol: PROTOCOL_VERSION,
          manifestHash: hashCanonical(options.manifest as never),
          kernelVersion: KERNEL_VERSION,
        })
      },
      init: (message) => {
        if (this.host !== null) {
          // A frame runs one session. A second init would either restart a run
          // in progress or quietly replace the seed under a finished one.
          this.error(
            FRAME_ERRORS.ALREADY_INITIALISED,
            "this frame already has a session",
          )
          return
        }
        try {
          this.host = options.createHost(
            {
              seed: message.seed,
              config: message.config,
              tickHz: message.tickHz,
              maxTicks: message.maxTicks,
            },
            this,
          )
        } catch (error) {
          this.error(
            FRAME_ERRORS.INIT_FAILED,
            error instanceof Error ? error.message : String(error),
          )
        }
      },
      start: () => {
        const host = this.require("start")
        if (host === null) return
        host.start()
        this.post({ type: "started" })
      },
      pause: () => {
        this.host?.pause()
      },
      resume: () => {
        this.host?.resume()
      },
      end: () => {
        this.host?.stop()
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
        this.host?.live?.push({
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

  private require(what: string): GameHost<TView, HTMLElement> | null {
    if (this.host !== null) return this.host
    this.error(FRAME_ERRORS.NOT_INITIALISED, `${what} arrived before init`)
    return null
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

  /**
   * Sends whatever the input log has grown since the last slice.
   *
   * Call it from the host's onFrame beside `progress`. It sends nothing when
   * the log has not grown, and nothing at all for a replayed session, which
   * has no live queue to read.
   */
  logChunk(now: number): void {
    if (now - this.lastLogChunkAt < LOG_CHUNK_INTERVAL_MS) return
    if (this.flushLog()) this.lastLogChunkAt = now
  }

  heartbeat(tick: number): void {
    this.post({ type: "heartbeat", tick })
  }

  /**
   * Call from the host's onEnded. Sends the result, the tail of the log, then
   * the recording.
   *
   * The tail matters: without it the last inputs of a run would only ever
   * reach the parent inside the recording, and the parent could not tell a log
   * that grew normally from one rewritten at the end.
   */
  ended(result: SessionResult, recording: string): void {
    this.flushLog()
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

  /** Posts whatever the log has grown since the last slice. */
  private flushLog(): boolean {
    const log = this.host?.live?.recorded()
    if (log === undefined || log.length <= this.logSentUpTo) return false
    const fromIndex = this.logSentUpTo
    const inputs = log.slice(fromIndex)
    this.logSentUpTo = log.length
    this.post({ type: "log-chunk", fromIndex, inputs })
    return true
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
  return new FrameBridge(options)
}

export { encodeRecording }
