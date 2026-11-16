/**
 * The host's half: an iframe on a separate origin, and the messages to it.
 *
 * The frame is `sandbox="allow-scripts"` *without* `allow-same-origin`.
 * Together those two tokens let an embedded document with the same origin as
 * its embedder remove its own sandbox, so the pair is never used. Without
 * `allow-same-origin` the frame sits in an opaque origin, which is
 * same-origin with nothing: no storage, no cookies, no reach into the page.
 *
 * An opaque origin also means the frame's `event.origin` is "null", so the
 * parent cannot check it. It checks `event.source` against the frame's own
 * window instead, which is the identity that actually matters here.
 *
 * The page also reads tilt and passes it in (`forwardMotion`), because a
 * sensor's events never reach a cross-origin frame in Firefox, and iOS asks
 * the player's permission only from a tap on the page itself.
 */

import { fail } from "../../errors.js"
import type { InputEvent } from "../../index.js"
import {
  createDispatcher,
  type GameToHost,
  type HostToGame,
  PROTOCOL_VERSION,
} from "../protocol/index.js"
import {
  isMotionAngle,
  type MotionAccess,
  type MotionEnvironment,
  motionEnvironment,
} from "./motion.js"

export interface GameFrameOptions {
  readonly container: HTMLElement
  /** The game document, served from an origin of its own. */
  readonly src: string
  readonly title?: string
  /**
   * The permissions policy delegated to the frame. Each feature needs `*`:
   * a bare name means the frame's own origin, which for a sandboxed frame is
   * a fresh opaque origin that matches nothing, so Firefox and Safari turn
   * the feature off (measured for `fullscreen`). `gamepad *` repeats every
   * browser's default and is written so nobody narrows it by accident.
   * `autoplay` does something only in Chromium. No sensor is delegated:
   * the page reads tilt itself.
   */
  readonly allow?: string
  /**
   * Says hello once the frame document has loaded. On by default.
   *
   * A message posted before the frame's script has run reaches the blank
   * document the iframe starts on, where nothing is listening, and nothing
   * retries it: the handshake never starts and the frame looks broken with no
   * error anywhere. Load is the only signal the parent gets, since everything
   * else about an opaque origin is hidden from it. Turn this off to drive the
   * handshake by hand.
   */
  readonly helloOnLoad?: boolean
  readonly onReady?: (message: Extract<GameToHost, { type: "ready" }>) => void
  readonly onStarted?: () => void
  readonly onProgress?: (
    message: Extract<GameToHost, { type: "progress" }>,
  ) => void
  readonly onCheckpoint?: (
    message: Extract<GameToHost, { type: "checkpoint" }>,
  ) => void
  readonly onEnded?: (message: Extract<GameToHost, { type: "ended" }>) => void
  /**
   * A slice of the input log, arriving while the run is still going.
   *
   * Stamp it with the server's clock and keep it. It is what lets a submitted
   * recording be checked against what the player had already committed to,
   * before they knew how the run would end.
   */
  readonly onLogChunk?: (
    message: Extract<GameToHost, { type: "log-chunk" }>,
  ) => void
  readonly onRecordingChunk?: (
    message: Extract<GameToHost, { type: "recording-chunk" }>,
  ) => void
  readonly onError?: (message: Extract<GameToHost, { type: "error" }>) => void
  readonly onHeartbeat?: (
    message: Extract<GameToHost, { type: "heartbeat" }>,
  ) => void
  /** A device problem the player should hear about. Never a reason to end the run. */
  readonly onNotice?: (message: Extract<GameToHost, { type: "notice" }>) => void
  /** For a test: where tilt is heard and the screen's angle read. */
  readonly motionEnvironment?: MotionEnvironment
}

/** The frame's sandbox. Pointer lock is allowed so a game that binds mouse movement can lock. */
export const FRAME_SANDBOX = "allow-scripts allow-pointer-lock"

export const FRAME_ALLOW = "autoplay *; fullscreen *; gamepad *"

export class GameFrame {
  private readonly iframe: HTMLIFrameElement
  private readonly onMessage: (event: MessageEvent) => void
  private readonly onLoad = (): void => {
    this.hello()
  }
  private destroyed = false
  private stopMotion: (() => void) | null = null

  constructor(private readonly options: GameFrameOptions) {
    const iframe = document.createElement("iframe")
    // Deliberately not allow-same-origin. See the note above.
    iframe.setAttribute("sandbox", FRAME_SANDBOX)
    iframe.setAttribute("allow", options.allow ?? FRAME_ALLOW)
    iframe.setAttribute("title", options.title ?? "Game")
    iframe.style.border = "0"
    iframe.style.width = "100%"
    iframe.style.height = "100%"
    if (options.helloOnLoad !== false) {
      iframe.addEventListener("load", this.onLoad)
    }
    iframe.src = options.src
    options.container.appendChild(iframe)
    this.iframe = iframe

    const dispatch = createDispatcher<GameToHost>({
      ready: (message) => options.onReady?.(message),
      started: () => options.onStarted?.(),
      progress: (message) => options.onProgress?.(message),
      checkpoint: (message) => options.onCheckpoint?.(message),
      ended: (message) => options.onEnded?.(message),
      "log-chunk": (message) => options.onLogChunk?.(message),
      "recording-chunk": (message) => options.onRecordingChunk?.(message),
      error: (message) => options.onError?.(message),
      heartbeat: (message) => options.onHeartbeat?.(message),
      notice: (message) => options.onNotice?.(message),
      // There is no navigate row, and there is not meant to be one.
    })

    this.onMessage = (event: MessageEvent): void => {
      // The frame is in an opaque origin, so its event.origin is "null" and
      // checking it proves nothing. The window identity is what matters.
      if (event.source !== iframe.contentWindow) return
      dispatch(event.data)
    }
    globalThis.addEventListener("message", this.onMessage)
  }

  private post(message: HostToGame): void {
    if (this.destroyed) return
    // An opaque origin is same-origin with nothing, so "*" is the only target
    // that reaches it. Nothing sensitive travels this way, which is why that
    // is acceptable: the frame gets a seed, a config and the player's input.
    this.iframe.contentWindow?.postMessage(message, "*")
  }

  hello(): void {
    this.post({ type: "hello", protocol: PROTOCOL_VERSION })
  }

  /**
   * Starts a session, live or replayed.
   *
   * `replay.inputs` makes it a replay: the frame hands the log to the same
   * loop a live run uses, and captures no device input for it. `replay.speed`
   * is only meaningful there, and the frame refuses one without a log -
   * speed on a live session is a player slowing the game down to play it.
   */
  init(
    seed: string,
    config: unknown,
    tickHz: 30 | 60 | 120,
    maxTicks: number,
    replay?: {
      readonly inputs: readonly InputEvent[]
      readonly speed?: number
    },
  ): void {
    this.post({
      type: "init",
      seed,
      config,
      tickHz,
      maxTicks,
      ...(replay === undefined ? {} : { inputs: replay.inputs }),
      ...(replay?.speed === undefined ? {} : { speed: replay.speed }),
    })
  }

  start(): void {
    this.post({ type: "start" })
  }

  pause(): void {
    this.post({ type: "pause" })
  }

  resume(): void {
    this.post({ type: "resume" })
  }

  end(): void {
    this.post({ type: "end" })
  }

  resize(width: number, height: number, devicePixelRatio: number): void {
    this.post({ type: "resize", width, height, devicePixelRatio })
  }

  setTheme(theme: string): void {
    this.post({ type: "theme", theme })
  }

  /**
   * Passes the page's tilt readings to the frame until `stop` or `destroy`.
   *
   * `access` is what `requestMotion` answered on the player's tap, and only
   * a grant is accepted. A reading the browser did not make (`isTrusted`
   * false) or one with no angles, which a device with no sensor sends, is
   * skipped here; the frame checks every field again.
   */
  forwardMotion(access: MotionAccess): () => void {
    if (!access.granted) {
      fail("E_ARG_INVALID", {
        detail: `tilt was not granted (${access.code}), so there is nothing to forward`,
      })
    }
    this.stopMotion?.()
    const environment = this.options.motionEnvironment ?? motionEnvironment()
    const onOrientation = (event: Event): void => {
      if (!event.isTrusted) return
      const { beta, gamma } = event as DeviceOrientationEvent
      const angle = environment.screenAngle()
      if (beta === null || gamma === null || !isMotionAngle(angle)) return
      this.post({ type: "motion", beta, gamma, angle })
    }
    environment.window.addEventListener("deviceorientation", onOrientation)
    const stop = (): void => {
      environment.window.removeEventListener("deviceorientation", onOrientation)
      if (this.stopMotion === stop) this.stopMotion = null
    }
    this.stopMotion = stop
    return stop
  }

  get element(): HTMLIFrameElement {
    return this.iframe
  }

  destroy(): void {
    if (this.destroyed) return
    this.destroyed = true
    this.stopMotion?.()
    globalThis.removeEventListener("message", this.onMessage)
    this.iframe.removeEventListener("load", this.onLoad)
    this.iframe.remove()
    void this.options
  }
}

export function createGameFrame(options: GameFrameOptions): GameFrame {
  return new GameFrame(options)
}

export {
  isMotionAngle,
  MOTION_REFUSALS,
  type MotionAccess,
  type MotionEnvironment,
  type MotionRefusal,
  requestMotion,
} from "./motion.js"
