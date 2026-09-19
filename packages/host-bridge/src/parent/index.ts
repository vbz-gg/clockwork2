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
 */

import {
  createDispatcher,
  type GameToHost,
  type HostToGame,
  PROTOCOL_VERSION,
} from "../protocol/index"

export interface GameFrameOptions {
  readonly container: HTMLElement
  /** The game document, served from an origin of its own. */
  readonly src: string
  readonly title?: string
  /** Features to grant. Pointer lock only when the manifest asks for it. */
  readonly allow?: string
  readonly onReady?: (message: Extract<GameToHost, { type: "ready" }>) => void
  readonly onStarted?: () => void
  readonly onProgress?: (
    message: Extract<GameToHost, { type: "progress" }>,
  ) => void
  readonly onCheckpoint?: (
    message: Extract<GameToHost, { type: "checkpoint" }>,
  ) => void
  readonly onEnded?: (message: Extract<GameToHost, { type: "ended" }>) => void
  readonly onRecordingChunk?: (
    message: Extract<GameToHost, { type: "recording-chunk" }>,
  ) => void
  readonly onError?: (message: Extract<GameToHost, { type: "error" }>) => void
  readonly onHeartbeat?: (
    message: Extract<GameToHost, { type: "heartbeat" }>,
  ) => void
}

export class GameFrame {
  private readonly iframe: HTMLIFrameElement
  private readonly onMessage: (event: MessageEvent) => void
  private destroyed = false

  constructor(private readonly options: GameFrameOptions) {
    const iframe = document.createElement("iframe")
    // Deliberately not allow-same-origin. See the note above.
    iframe.setAttribute("sandbox", "allow-scripts")
    iframe.setAttribute("allow", options.allow ?? "autoplay; fullscreen")
    iframe.setAttribute("title", options.title ?? "Game")
    iframe.style.border = "0"
    iframe.style.width = "100%"
    iframe.style.height = "100%"
    iframe.src = options.src
    options.container.appendChild(iframe)
    this.iframe = iframe

    const dispatch = createDispatcher<GameToHost>({
      ready: (message) => options.onReady?.(message),
      started: () => options.onStarted?.(),
      progress: (message) => options.onProgress?.(message),
      checkpoint: (message) => options.onCheckpoint?.(message),
      ended: (message) => options.onEnded?.(message),
      "recording-chunk": (message) => options.onRecordingChunk?.(message),
      error: (message) => options.onError?.(message),
      heartbeat: (message) => options.onHeartbeat?.(message),
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

  init(
    seed: string,
    config: unknown,
    tickHz: 30 | 60 | 120,
    maxTicks: number,
  ): void {
    this.post({ type: "init", seed, config, tickHz, maxTicks })
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

  /** From a host-drawn on-screen control, and from nowhere else. */
  virtualInput(action: string, value: number): void {
    this.post({ type: "virtual-input", action, value })
  }

  get element(): HTMLIFrameElement {
    return this.iframe
  }

  destroy(): void {
    if (this.destroyed) return
    this.destroyed = true
    globalThis.removeEventListener("message", this.onMessage)
    this.iframe.remove()
    void this.options
  }
}

export function createGameFrame(options: GameFrameOptions): GameFrame {
  return new GameFrame(options)
}
