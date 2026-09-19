import { describe, expect, test } from "bun:test"
import {
  createDispatcher,
  type GameToHost,
  type HostToGame,
  PROTOCOL_VERSION,
} from "../src/protocol/index"

describe("the message table", () => {
  test("routes every message type it declares", () => {
    const seen: string[] = []
    const dispatch = createDispatcher<HostToGame>({
      hello: () => seen.push("hello"),
      init: () => seen.push("init"),
      start: () => seen.push("start"),
      pause: () => seen.push("pause"),
      resume: () => seen.push("resume"),
      end: () => seen.push("end"),
      resize: () => seen.push("resize"),
      theme: () => seen.push("theme"),
      "virtual-input": () => seen.push("virtual-input"),
    })
    for (const type of [
      "hello",
      "init",
      "start",
      "pause",
      "resume",
      "end",
      "resize",
      "theme",
      "virtual-input",
    ]) {
      expect(dispatch({ type })).toBe(true)
    }
    expect(seen.length).toBe(9)
  })

  test("drops an unknown type rather than throwing", () => {
    // The frame is untrusted code. A message it invents must not be able to
    // stop the host.
    const dispatch = createDispatcher<GameToHost>({
      ready: () => undefined,
      started: () => undefined,
      progress: () => undefined,
      checkpoint: () => undefined,
      ended: () => undefined,
      "recording-chunk": () => undefined,
      error: () => undefined,
      heartbeat: () => undefined,
    })
    expect(dispatch({ type: "navigate", url: "https://example.invalid" })).toBe(
      false,
    )
    expect(dispatch({ type: "eval", code: "alert(1)" })).toBe(false)
    expect(dispatch(null)).toBe(false)
    expect(dispatch("start")).toBe(false)
    expect(dispatch(42)).toBe(false)
    expect(dispatch({})).toBe(false)
    expect(dispatch({ type: 7 })).toBe(false)
  })

  test("there is no navigate row, and adding one would be a visible diff", () => {
    // The table is the whole vocabulary. This reads it back as data so that a
    // new row cannot arrive without this test noticing.
    const hostToGame = [
      "hello",
      "init",
      "start",
      "pause",
      "resume",
      "end",
      "resize",
      "theme",
      "virtual-input",
    ]
    const gameToHost = [
      "ready",
      "started",
      "progress",
      "checkpoint",
      "ended",
      "recording-chunk",
      "error",
      "heartbeat",
    ]
    const source = Bun.file(
      new URL("../src/protocol/index.ts", import.meta.url).pathname,
    )
    return source.text().then((text) => {
      const declared = [...text.matchAll(/readonly type: "([a-z-]+)"/g)].map(
        (match) => match[1] as string,
      )
      expect([...new Set(declared)].sort()).toEqual(
        [...hostToGame, ...gameToHost].sort(),
      )
      expect(declared).not.toContain("navigate")
    })
  })

  test("the protocol version is stated in both directions", () => {
    expect(PROTOCOL_VERSION).toBe(1)
  })
})
