/**
 * The frame half of the bridge, which is the arcade's trust boundary.
 *
 * A fake window pair stands in for a real iframe so the handshake is something
 * a test states rather than waits for. What it exercises is the real
 * `FrameBridge` against the real `GameHost`: the ordering rules, the two
 * rejections, and the input log arriving before the run is over.
 */

import { afterEach, describe, expect, test } from "bun:test"
import type { InputEvent } from "@clockwork2/kernel"
import {
  createReferenceGame,
  REFERENCE_CONFIG,
  REFERENCE_MANIFEST,
} from "@clockwork2/kernel/testing"
import { connectToParent, type FrameBridge } from "../src/frame/index"
import { GameHost, ManualScheduler } from "../src/index"
import { FRAME_ERRORS, type GameToHost } from "../src/protocol/index"

const PARENT = "https://play.example"

/**
 * Stands in for the frame's global: the listener it registers, and the parent
 * it posts to. Delivery is synchronous, so nothing here can go flaky.
 */
class FakeFrameWindow {
  readonly posted: GameToHost[] = []
  private listeners: Array<(event: MessageEvent) => void> = []

  readonly globals = {
    addEventListener: (_type: string, listener: unknown): void => {
      this.listeners.push(listener as (event: MessageEvent) => void)
    },
    removeEventListener: (_type: string, listener: unknown): void => {
      this.listeners = this.listeners.filter((l) => l !== listener)
    },
    parent: {
      postMessage: (message: unknown): void => {
        this.posted.push(message as GameToHost)
      },
    },
  }

  /** Delivers a message as the parent would. */
  send(data: unknown, origin = PARENT): void {
    for (const listener of [...this.listeners]) {
      listener({ data, origin } as MessageEvent)
    }
  }

  of<K extends GameToHost["type"]>(
    type: K,
  ): Array<Extract<GameToHost, { type: K }>> {
    return this.posted.filter((m) => m.type === type) as Array<
      Extract<GameToHost, { type: K }>
    >
  }

  get listenerCount(): number {
    return this.listeners.length
  }
}

type Installed = {
  window: FakeFrameWindow
  scheduler: ManualScheduler
  hostOf: () => GameHost<unknown, HTMLElement> | null
  bridge: FrameBridge<unknown>
}

const restores: Array<() => void> = []

function install(options: { failInit?: boolean } = {}): Installed {
  const window = new FakeFrameWindow()
  const target = globalThis as unknown as Record<string, unknown>
  const saved = {
    addEventListener: target.addEventListener,
    removeEventListener: target.removeEventListener,
    parent: target.parent,
  }
  target.addEventListener = window.globals.addEventListener
  target.removeEventListener = window.globals.removeEventListener
  target.parent = window.globals.parent
  restores.push(() => {
    target.addEventListener = saved.addEventListener
    target.removeEventListener = saved.removeEventListener
    target.parent = saved.parent
  })

  const scheduler = new ManualScheduler()
  let host: GameHost<unknown, HTMLElement> | null = null

  const bridge = connectToParent<unknown>({
    manifest: REFERENCE_MANIFEST,
    parentOrigin: PARENT,
    createHost: (init, self) => {
      if (options.failInit === true) throw new Error("no renderer here")
      const made = new GameHost<unknown, HTMLElement>({
        module: createReferenceGame(),
        manifest: REFERENCE_MANIFEST,
        seed: init.seed,
        config: REFERENCE_CONFIG,
        scheduler,
        maxTicks: init.maxTicks,
        checkpointEvery: REFERENCE_MANIFEST.session.tickHz,
        onCheckpoint: (checkpoint) =>
          self.checkpoint(checkpoint.tick, checkpoint.hash),
        onFrame: () => self.logChunk(scheduler.now()),
      })
      host = made
      return made
    },
  })

  return { window, scheduler, hostOf: () => host, bridge }
}

afterEach(() => {
  while (restores.length > 0) restores.pop()?.()
})

describe("the frame handshake", () => {
  test("answers hello with the manifest hash before any session exists", () => {
    const { window } = install()
    window.send({ type: "hello", protocol: 1 })

    const ready = window.of("ready")[0]
    expect(ready).toBeDefined()
    expect(ready?.manifestHash).toHaveLength(16)
    expect(ready?.kernelVersion).toBeTruthy()
  })

  test("builds the session from the seed in init, not from a URL", () => {
    // The whole reason init defers host construction: a frame that had to be
    // constructed with its seed could only have got it from its own src.
    const { window, hostOf } = install()
    window.send({ type: "hello", protocol: 1 })
    expect(hostOf()).toBeNull()

    window.send({
      type: "init",
      seed: "from-the-parent",
      config: REFERENCE_CONFIG,
      tickHz: 60,
      maxTicks: 600,
    })
    expect(hostOf()?.seed).toBe("from-the-parent")
  })

  test("start before init is refused rather than ignored", () => {
    const { window, hostOf } = install()
    window.send({ type: "start" })

    expect(hostOf()).toBeNull()
    expect(window.of("started")).toHaveLength(0)
    expect(window.of("error")[0]?.code).toBe(FRAME_ERRORS.NOT_INITIALISED)
  })

  test("a second init cannot replace the seed of a running session", () => {
    const { window, hostOf } = install()
    const init = {
      type: "init",
      config: REFERENCE_CONFIG,
      tickHz: 60,
      maxTicks: 600,
    }
    window.send({ ...init, seed: "first" })
    window.send({ ...init, seed: "second" })

    expect(hostOf()?.seed).toBe("first")
    expect(window.of("error")[0]?.code).toBe(FRAME_ERRORS.ALREADY_INITIALISED)
  })

  test("a createHost that throws is reported, not swallowed", () => {
    const { window, hostOf } = install({ failInit: true })
    window.send({
      type: "init",
      seed: "s",
      config: REFERENCE_CONFIG,
      tickHz: 60,
      maxTicks: 600,
    })

    expect(hostOf()).toBeNull()
    const error = window.of("error")[0]
    expect(error?.code).toBe(FRAME_ERRORS.INIT_FAILED)
    expect(error?.detail).toBe("no renderer here")
  })
})

describe("who the frame will listen to", () => {
  test("a message from any other origin is dropped", () => {
    const { window, hostOf } = install()
    window.send(
      {
        type: "init",
        seed: "attacker",
        config: REFERENCE_CONFIG,
        tickHz: 60,
        maxTicks: 600,
      },
      "https://evil.example",
    )

    expect(hostOf()).toBeNull()
    expect(window.posted).toHaveLength(0)
  })

  test("a type the table does not have is dropped, not thrown on", () => {
    const { window } = install()
    expect(() =>
      window.send({ type: "navigate", url: "https://evil.example" }),
    ).not.toThrow()
    expect(window.posted).toHaveLength(0)
  })

  test("destroy stops listening", () => {
    const { window, bridge } = install()
    expect(window.listenerCount).toBe(1)
    bridge.destroy()
    expect(window.listenerCount).toBe(0)

    window.send({ type: "hello", protocol: 1 })
    expect(window.posted).toHaveLength(0)
  })
})

describe("the input log reaches the parent before the run ends", () => {
  function play(): Installed {
    const installed = install()
    installed.window.send({ type: "hello", protocol: 1 })
    installed.window.send({
      type: "init",
      seed: "log-chunks",
      config: REFERENCE_CONFIG,
      tickHz: 60,
      maxTicks: 6000,
    })
    installed.window.send({ type: "start" })
    return installed
  }

  test("slices arrive while the session is still running", () => {
    const { window, scheduler, hostOf } = play()
    const host = hostOf()
    expect(host).not.toBeNull()

    // Press through the real path, then run enough frames for the rate
    // limit to open several times. 400 frames at 60 Hz is 6.7 seconds of
    // virtual clock against a 2 second interval.
    for (let frame = 0; frame < 400; frame++) {
      window.send({ type: "virtual-input", action: "thrust", value: 1 })
      scheduler.advance(1000 / 60)
    }

    const chunks = window.of("log-chunk")
    expect(chunks.length).toBeGreaterThan(0)
    expect(window.of("ended")).toHaveLength(0)

    // Every input appears once, in order, with no gap between slices.
    let expected = 0
    const seen: InputEvent[] = []
    for (const chunk of chunks) {
      expect(chunk.fromIndex).toBe(expected)
      expected += chunk.inputs.length
      seen.push(...chunk.inputs)
    }
    expect(seen.length).toBeGreaterThan(0)
    for (let i = 1; i < seen.length; i++) {
      expect(seen[i]?.tick).toBeGreaterThanOrEqual(seen[i - 1]?.tick ?? 0)
    }
  })

  test("the tail is flushed before ended, so no input arrives only in the recording", () => {
    const { window, scheduler, hostOf, bridge } = play()
    const host = hostOf()

    for (let frame = 0; frame < 20; frame++) {
      window.send({ type: "virtual-input", action: "thrust", value: 1 })
      scheduler.advance(1000 / 60)
    }
    // Too few frames for the rate limit to have opened even once.
    expect(window.of("log-chunk")).toHaveLength(0)

    const result = host?.result()
    if (result !== undefined) bridge.ended(result, "{}")

    const chunks = window.of("log-chunk")
    expect(chunks).toHaveLength(1)
    expect(chunks[0]?.fromIndex).toBe(0)
    expect(chunks[0]?.inputs.length).toBe(host?.live?.recorded().length)

    // And it is sent before the result, not after.
    const types = window.posted.map((m) => m.type)
    expect(types.indexOf("log-chunk")).toBeLessThan(types.indexOf("ended"))
  })
})

describe("a session ends once, and destroy ends it", () => {
  function running() {
    const installed = install()
    installed.window.send({ type: "hello", protocol: 1 })
    installed.window.send({
      type: "init",
      seed: "once",
      config: REFERENCE_CONFIG,
      tickHz: 60,
      maxTicks: 6000,
    })
    installed.window.send({ type: "start" })
    return installed
  }

  test("destroy stops the session, not just the listening", () => {
    // Removing the listener alone left the host running: its scheduler kept
    // going and its onCheckpoint kept calling back into the bridge, so a
    // destroyed frame carried on posting at a parent that had gone.
    const { window, scheduler, hostOf, bridge } = running()
    for (let frame = 0; frame < 70; frame++) scheduler.advance(1000 / 60)
    expect(window.of("checkpoint").length).toBeGreaterThan(0)

    const before = window.posted.length
    bridge.destroy()
    expect(hostOf()?.status).toBe("ended")

    for (let frame = 0; frame < 200; frame++) scheduler.advance(1000 / 60)
    expect(window.posted.length).toBe(before)
  })

  test("nothing is posted after destroy even if a callback still fires", () => {
    const { window, bridge } = running()
    // The session checkpoints at tick 0, so count from the teardown rather
    // than from zero.
    const before = window.posted.length
    bridge.destroy()
    bridge.checkpoint(600, "deadbeefdeadbeef")
    bridge.heartbeat(600)
    bridge.error("E_TEST", "should not reach the parent")
    expect(window.posted.length).toBe(before)
  })

  test("a second start is refused rather than answered again", () => {
    // GameHost refuses to restart an ended session, but a second `started`
    // would still leave the parent waiting for a second result - and a shell
    // whose effect runs twice sends one without meaning to.
    const { window } = running()
    window.send({ type: "start" })

    expect(window.of("started")).toHaveLength(1)
    expect(window.of("error")[0]?.code).toBe(FRAME_ERRORS.ALREADY_STARTED)
  })

  test("a run that has ended is not restarted into a second result", () => {
    const { window, scheduler, hostOf } = running()
    for (let frame = 0; frame < 20; frame++) scheduler.advance(1000 / 60)
    window.send({ type: "end" })
    const tickAtEnd = hostOf()?.tick

    window.send({ type: "start" })
    for (let frame = 0; frame < 20; frame++) scheduler.advance(1000 / 60)

    expect(hostOf()?.status).toBe("ended")
    expect(hostOf()?.tick).toBe(tickAtEnd as number)
    expect(window.of("started")).toHaveLength(1)
  })
})
