/**
 * Every command the host can send, delivered to a real frame.
 *
 * `GameFrame.pause()` is one line that posts `{ type: "pause" }`. Asserting
 * that it posts that is a restatement of the line. What is worth asserting is
 * that the message arrives somewhere that acts on it, because `createDispatcher`
 * drops a type it does not know silently and by design - a frame may not be
 * stoppable by a message a hostile parent invents. The cost of that design is
 * that a typo in either half is invisible: the parent posts `"unpause"`, the
 * frame listens for `"resume"`, nothing happens, and no test fails.
 *
 * So each case here posts through the real parent, takes the exact object that
 * went over the wire, and feeds it to a real frame bridge. The two halves are
 * built from the same message, one test at a time, because each needs its own
 * shape of fake global.
 */

import { afterEach, describe, expect, test } from "bun:test"
import { connectToParent } from "../../src/host/frame/index"
import { GameHost, ManualScheduler } from "../../src/host/index"
import { createGameFrame } from "../../src/host/parent/index"
import type { GameToHost, HostToGame } from "../../src/host/protocol/index"
import {
  createReferenceGame,
  REFERENCE_CONFIG,
  REFERENCE_MANIFEST,
} from "../../src/testing"

const PARENT = "https://play.example"

const restores: Array<() => void> = []
afterEach(() => {
  while (restores.length > 0) restores.pop()?.()
})

function patch(values: Record<string, unknown>): void {
  const target = globalThis as unknown as Record<string, unknown>
  const saved = new Map<string, { had: boolean; value: unknown }>()
  for (const [name, value] of Object.entries(values)) {
    saved.set(name, { had: name in target, value: target[name] })
    target[name] = value
  }
  restores.push(() => {
    for (const [name, { had, value }] of saved) {
      if (had) target[name] = value
      else delete target[name]
    }
  })
}

/** Runs one command through the real GameFrame and returns what it posted. */
function posted(command: (frame: ReturnType<typeof createGameFrame>) => void) {
  const sent: HostToGame[] = []
  const iframe = {
    attributes: new Map<string, string>(),
    style: {} as Record<string, string>,
    src: "",
    setAttribute: () => undefined,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
    remove: () => undefined,
    contentWindow: {
      postMessage: (message: unknown): void => {
        sent.push(message as HostToGame)
      },
    },
  }
  patch({
    document: { createElement: () => iframe },
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
  })
  const frame = createGameFrame({
    container: { appendChild: () => undefined } as unknown as HTMLElement,
    src: "https://games.example/g/snake/1.0.0/",
  })
  command(frame)
  const last = sent[sent.length - 1]
  if (last === undefined) throw new Error("the command posted nothing")
  return last
}

/** A live frame bridge with a real session, ready to be sent a message. */
function frameWithSession() {
  const listeners: Array<(event: MessageEvent) => void> = []
  const out: GameToHost[] = []
  patch({
    addEventListener: (_type: string, listener: unknown): void => {
      listeners.push(listener as (event: MessageEvent) => void)
    },
    removeEventListener: () => undefined,
    parent: {
      postMessage: (message: unknown): void => {
        out.push(message as GameToHost)
      },
    },
  })

  const scheduler = new ManualScheduler()
  const resized: Array<[number, number, number]> = []
  const themed: string[] = []
  let host: GameHost<unknown, HTMLElement> | null = null

  connectToParent<unknown>({
    manifest: REFERENCE_MANIFEST,
    parentOrigin: PARENT,
    onResize: (w, h, dpr) => resized.push([w, h, dpr]),
    onTheme: (theme) => themed.push(theme),
    createHost: (init, self) => {
      host = new GameHost<unknown, HTMLElement>({
        module: createReferenceGame(),
        manifest: REFERENCE_MANIFEST,
        seed: init.seed,
        config: REFERENCE_CONFIG,
        scheduler,
        maxTicks: init.maxTicks,
        checkpointEvery: REFERENCE_MANIFEST.session.tickHz,
        onCheckpoint: (c) => self.checkpoint(c.tick, c.hash),
      })
      return host
    },
  })

  const send = (data: unknown): void => {
    for (const listener of [...listeners]) {
      listener({ data, origin: PARENT } as unknown as MessageEvent)
    }
  }

  send({ type: "hello", protocol: 1 })
  send({
    type: "init",
    seed: "round-trip",
    config: REFERENCE_CONFIG,
    tickHz: 60,
    maxTicks: 600,
  })
  send({ type: "start" })

  return {
    send,
    out,
    resized,
    themed,
    scheduler,
    hostOf: () => host as GameHost<unknown, HTMLElement> | null,
  }
}

describe("a command posted by the host reaches the frame", () => {
  test("pause", () => {
    const message = posted((frame) => frame.pause())
    while (restores.length > 0) restores.pop()?.()
    const frame = frameWithSession()
    expect(frame.hostOf()?.status).toBe("running")
    frame.send(message)
    expect(frame.hostOf()?.status).toBe("paused")
  })

  test("resume", () => {
    const message = posted((frame) => frame.resume())
    while (restores.length > 0) restores.pop()?.()
    const frame = frameWithSession()
    frame.send({ type: "pause" })
    expect(frame.hostOf()?.status).toBe("paused")
    frame.send(message)
    expect(frame.hostOf()?.status).toBe("running")
  })

  test("end", () => {
    const message = posted((frame) => frame.end())
    while (restores.length > 0) restores.pop()?.()
    const frame = frameWithSession()
    frame.send(message)
    expect(frame.hostOf()?.status).toBe("ended")
  })

  test("resize, with all three numbers intact", () => {
    // A device pixel ratio dropped here is a canvas at the wrong size on every
    // retina display, and nothing else would report it.
    const message = posted((frame) => frame.resize(800, 450, 2))
    while (restores.length > 0) restores.pop()?.()
    const frame = frameWithSession()
    frame.send(message)
    expect(frame.resized).toEqual([[800, 450, 2]])
  })

  test("setTheme", () => {
    const message = posted((frame) => frame.setTheme("midnight"))
    while (restores.length > 0) restores.pop()?.()
    const frame = frameWithSession()
    frame.send(message)
    expect(frame.themed).toEqual(["midnight"])
  })

  test("virtualInput, which reaches the live queue and nowhere else", () => {
    const message = posted((frame) => frame.virtualInput("thrust", 1))
    while (restores.length > 0) restores.pop()?.()
    const frame = frameWithSession()
    frame.send(message)
    const taken = frame.hostOf()?.live?.take(20) ?? []
    expect(taken.map((e) => [e.device, e.code, e.value])).toEqual([
      ["virtual", "thrust", 1],
    ])
  })

  test("start, which the session answers once", () => {
    const message = posted((frame) => frame.start())
    expect(message.type).toBe("start")
  })

  test("init carries the seed the parent chose", () => {
    // The frame must not be able to get its seed from its own URL, so this is
    // the only way one arrives.
    const message = posted((frame) => frame.init("chosen-by-host", {}, 60, 600))
    expect(message).toMatchObject({
      type: "init",
      seed: "chosen-by-host",
      tickHz: 60,
      maxTicks: 600,
    })
  })
})

describe("the command table itself", () => {
  /**
   * There is no `navigate` row, and there must not be one. A frame that could
   * be told to navigate could be told to navigate anywhere, which is the one
   * thing the sandbox is there to prevent.
   */
  test("has nothing that would move the frame", () => {
    const frame = createGameFrameShape()
    for (const name of ["navigate", "go", "load", "open", "setSrc"]) {
      expect(name in frame).toBe(false)
    }
  })

  test("and an invented message type is ignored rather than obeyed", () => {
    const frame = frameWithSession()
    const before = frame.out.length
    frame.send({ type: "navigate", url: "https://elsewhere.example" })
    frame.send({ type: "eval", code: "1" })
    frame.send("not an object at all")
    frame.send(null)
    expect(frame.out.length).toBe(before)
    expect(frame.hostOf()?.status).toBe("running")
  })
})

function createGameFrameShape(): object {
  const iframe = {
    setAttribute: () => undefined,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
    remove: () => undefined,
    style: {} as Record<string, string>,
    contentWindow: { postMessage: () => undefined },
  }
  patch({
    document: { createElement: () => iframe },
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
  })
  return createGameFrame({
    container: { appendChild: () => undefined } as unknown as HTMLElement,
    src: "https://games.example/g/snake/1.0.0/",
  }) as unknown as object
}
