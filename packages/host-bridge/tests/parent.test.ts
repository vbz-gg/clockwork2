/**
 * The host half of the bridge.
 *
 * Two things here are the sandbox, and neither is visible from inside the
 * frame: the iframe is built `allow-scripts` without `allow-same-origin`, and
 * the parent answers only the window it created. A fake document stands in for
 * a browser so both are checked without one; spec 08 then checks the same
 * handshake in a real sandboxed frame, where the attributes actually bite.
 */

import { describe, expect, test } from "bun:test"
import { createGameFrame, type GameFrame } from "../src/parent/index"
import type { GameToHost, HostToGame } from "../src/protocol/index"

class FakeIframe {
  readonly attributes = new Map<string, string>()
  readonly style: Record<string, string> = {}
  src = ""
  removed = false
  readonly received: Array<{ message: HostToGame; targetOrigin: string }> = []

  readonly contentWindow = {
    postMessage: (message: unknown, targetOrigin: string): void => {
      this.received.push({ message: message as HostToGame, targetOrigin })
    },
  }

  private loadListeners: Array<() => void> = []

  setAttribute(name: string, value: string): void {
    this.attributes.set(name, value)
  }

  addEventListener(_type: string, listener: unknown): void {
    this.loadListeners.push(listener as () => void)
  }

  removeEventListener(_type: string, listener: unknown): void {
    this.loadListeners = this.loadListeners.filter((l) => l !== listener)
  }

  /** Fires the load event the browser fires once the document is there. */
  load(): void {
    for (const listener of [...this.loadListeners]) listener()
  }

  get loadListenerCount(): number {
    return this.loadListeners.length
  }

  remove(): void {
    this.removed = true
  }
}

type Harness = {
  frame: GameFrame
  iframe: FakeIframe
  seen: GameToHost[]
  deliver: (data: unknown, source?: unknown) => void
  listenerCount: () => number
  restore: () => void
}

function harness(options: { helloOnLoad?: boolean } = {}): Harness {
  const iframe = new FakeIframe()
  const container = { appendChild: () => undefined }
  let listeners: Array<(event: MessageEvent) => void> = []

  const target = globalThis as unknown as Record<string, unknown>
  const saved = {
    document: target.document,
    addEventListener: target.addEventListener,
    removeEventListener: target.removeEventListener,
  }
  target.document = { createElement: () => iframe }
  target.addEventListener = (_type: string, listener: unknown): void => {
    listeners.push(listener as (event: MessageEvent) => void)
  }
  target.removeEventListener = (_type: string, listener: unknown): void => {
    listeners = listeners.filter((l) => l !== listener)
  }

  const seen: GameToHost[] = []
  const record = (message: GameToHost) => {
    seen.push(message)
  }
  const frame = createGameFrame({
    container: container as unknown as HTMLElement,
    src: "https://games.example/g/snake/1.0.0/",
    ...(options.helloOnLoad === undefined
      ? {}
      : { helloOnLoad: options.helloOnLoad }),
    onReady: record,
    onStarted: () => record({ type: "started" }),
    onProgress: record,
    onCheckpoint: record,
    onEnded: record,
    onLogChunk: record,
    onRecordingChunk: record,
    onError: record,
    onHeartbeat: record,
  })

  return {
    frame,
    iframe,
    seen,
    deliver: (data, source = iframe.contentWindow) => {
      for (const listener of [...listeners]) {
        listener({ data, source } as unknown as MessageEvent)
      }
    },
    listenerCount: () => listeners.length,
    restore: () => {
      target.document = saved.document
      target.addEventListener = saved.addEventListener
      target.removeEventListener = saved.removeEventListener
    },
  }
}

describe("how the frame is embedded", () => {
  test("sandboxed without allow-same-origin", () => {
    // The two tokens together let a same-origin frame remove its own sandbox,
    // so the pair is never used. This is the line that keeps the frame in an
    // opaque origin, and nothing inside the frame can tell.
    const h = harness()
    const sandbox = h.iframe.attributes.get("sandbox")
    expect(sandbox).toBe("allow-scripts")
    expect(sandbox).not.toContain("allow-same-origin")
    h.restore()
  })

  test("grants no feature the game did not ask for", () => {
    const h = harness()
    expect(h.iframe.attributes.get("allow")).toBe("autoplay; fullscreen")
    expect(h.iframe.attributes.get("allow")).not.toContain("pointer-lock")
    h.restore()
  })
})

describe("starting the conversation", () => {
  test("nothing is said until the frame document has loaded", () => {
    // A hello posted before the frame's script runs reaches the blank
    // document the iframe starts on, where nobody is listening, and nothing
    // retries it. That failure is silent: no error, no ready, a frame that
    // looks broken.
    const h = harness()
    expect(h.iframe.received).toHaveLength(0)

    h.iframe.load()
    expect(h.iframe.received[0]?.message).toEqual({
      type: "hello",
      protocol: 1,
    })
    h.restore()
  })

  test("a host that wants to drive the handshake itself can", () => {
    const h = harness({ helloOnLoad: false })
    expect(h.iframe.loadListenerCount).toBe(0)
    h.iframe.load()
    expect(h.iframe.received).toHaveLength(0)

    h.frame.hello()
    expect(h.iframe.received).toHaveLength(1)
    h.restore()
  })
})

describe("who the parent will listen to", () => {
  test("a message from another window is dropped", () => {
    // The frame's origin reads "null" because it is opaque, so origin proves
    // nothing here and window identity is the check.
    const h = harness()
    h.deliver(
      { type: "ready", protocol: 1, manifestHash: "x", kernelVersion: "0.1.0" },
      {
        postMessage: () => undefined,
      },
    )
    expect(h.seen).toHaveLength(0)
    h.restore()
  })

  test("a message from the frame is routed", () => {
    const h = harness()
    h.deliver({
      type: "ready",
      protocol: 1,
      manifestHash: "e4d755ee070bbde2",
      kernelVersion: "0.1.0",
    })
    expect(h.seen[0]?.type).toBe("ready")
    h.restore()
  })

  test("a log chunk reaches its handler", () => {
    const h = harness()
    h.deliver({
      type: "log-chunk",
      fromIndex: 0,
      inputs: [{ tick: 3, device: "key", code: "left", value: 1 }],
    })
    const chunk = h.seen[0]
    expect(chunk?.type).toBe("log-chunk")
    h.restore()
  })

  test("an invented type is dropped rather than thrown on", () => {
    const h = harness()
    expect(() =>
      h.deliver({ type: "navigate", url: "https://evil.example" }),
    ).not.toThrow()
    expect(() => h.deliver({ type: "eval", code: "alert(1)" })).not.toThrow()
    expect(h.seen).toHaveLength(0)
    h.restore()
  })
})

describe("what the parent sends", () => {
  test("init carries the seed, so the frame's URL never has to", () => {
    const h = harness({ helloOnLoad: false })
    h.frame.init("day-seed-8f3a", { speed: 1 }, 60, 18_000)

    const sent = h.iframe.received[0]
    expect(sent?.message).toEqual({
      type: "init",
      seed: "day-seed-8f3a",
      config: { speed: 1 },
      tickHz: 60,
      maxTicks: 18_000,
    })
    expect(h.iframe.src).not.toContain("day-seed-8f3a")
    h.restore()
  })

  test("posts with target origin * because the frame has no origin to name", () => {
    const h = harness({ helloOnLoad: false })
    h.frame.hello()
    expect(h.iframe.received[0]?.targetOrigin).toBe("*")
    h.restore()
  })

  test("nothing is sent after destroy, and the listener is gone", () => {
    const h = harness({ helloOnLoad: false })
    expect(h.listenerCount()).toBe(1)
    h.frame.destroy()

    expect(h.listenerCount()).toBe(0)
    expect(h.iframe.removed).toBe(true)
    h.frame.start()
    expect(h.iframe.received).toHaveLength(0)
    h.restore()
  })
})

describe("the frame element", () => {
  /**
   * The host positions and sizes the frame it created. Handing back anything
   * else would let a host style a node that is not the one the session is
   * running in, and the mistake would only show as a layout that does not
   * respond.
   */
  test("is the iframe the frame built, not a copy", () => {
    const h = harness()
    expect(h.frame.element).toBe(h.iframe as unknown as HTMLIFrameElement)
    h.restore()
  })
})
