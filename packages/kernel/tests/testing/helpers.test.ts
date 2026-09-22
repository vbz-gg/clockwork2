/**
 * The shipped test helpers: the three standard input logs, and the comparison
 * that every suite built on them reports divergence with.
 *
 * These are not test scaffolding, they are public API. The conformance suite,
 * the probe, the demo's fixtures and the agent skill's headless script all run
 * on `standardLogs`, and all four describe a divergence with `compare.ts`. A
 * comparator that failed to spot a difference would make every test built on it
 * vacuous, and it would do so silently: every suite would still be green.
 */

import { describe, expect, test } from "bun:test"
import { validateInputLog } from "../../src/inputs"
import type { Checkpoint, SessionResult } from "../../src/loop"
import {
  compareCheckpoints,
  compareCounters,
  compareResults,
  compareSnapshots,
} from "../../src/testing/compare"
import {
  ACTIONS,
  botLog,
  chaosLog,
  idleLog,
  standardLogs,
} from "../../src/testing/input-logs"

describe("the standard logs", () => {
  /**
   * The names are a contract across three places that do not import each
   * other: this map, the agent skill's run-headless script which iterates it,
   * and the conformance suite's support.ts which hand-builds the same three.
   * Drift means a game passes the skill's script and fails conformance, or the
   * reverse, and nothing would say why.
   */
  test("are exactly idle, chaos and bot", () => {
    expect([...standardLogs("s", 600).keys()]).toEqual(["idle", "chaos", "bot"])
  })

  test("idle is empty, which is the point of it", () => {
    // A game that only fails with no input at all is a game that fails on the
    // first player who puts the controller down.
    expect(idleLog()).toEqual([])
    expect(standardLogs("s", 600).get("idle")).toEqual([])
  })

  test("chaos and bot both produce input", () => {
    const logs = standardLogs("s", 6000)
    expect((logs.get("chaos") ?? []).length).toBeGreaterThan(10)
    expect((logs.get("bot") ?? []).length).toBeGreaterThan(10)
  })

  test("the two are not the same log under different names", () => {
    const logs = standardLogs("s", 6000)
    expect(logs.get("chaos")).not.toEqual(logs.get("bot"))
  })

  /**
   * A generator that emitted an event at or past endTick would produce a log
   * the kernel refuses, and every suite that feeds it would fail somewhere
   * unrelated to what it was testing.
   */
  for (const [name, make] of [
    ["chaos", chaosLog],
    ["bot", botLog],
  ] as const) {
    test(`${name} produces a log the kernel accepts`, () => {
      for (const endTick of [1, 2, 17, 600, 20_000]) {
        const log = make("validity", endTick)
        expect(() => validateInputLog(log, { endTick })).not.toThrow()
        expect(log.every((e) => e.tick < endTick)).toBe(true)
      }
    })

    test(`${name} is a pure function of its seed`, () => {
      expect(make("same", 2000)).toEqual(make("same", 2000))
      expect(make("one", 2000)).not.toEqual(make("two", 2000))
    })

    test(`${name} only ever names a declared action`, () => {
      const codes = new Set(make("codes", 5000).map((e) => e.code))
      for (const code of codes) {
        expect(ACTIONS as readonly string[]).toContain(code)
      }
    })

    test(`${name} only ever presses or releases`, () => {
      const values = new Set(make("values", 5000).map((e) => e.value))
      expect([...values].sort()).toEqual([0, 1])
    })
  }

  test("a span of zero produces nothing rather than one event at tick zero", () => {
    // The kernel refuses an input at a tick the session never reaches.
    expect(chaosLog("empty", 0)).toEqual([])
    expect(botLog("empty", 0)).toEqual([])
  })
})

describe("comparing snapshots", () => {
  test("a field that differs", () => {
    expect(compareSnapshots({ x: 1 }, { x: 2 })).toEqual([
      "x: expected 1, got 2",
    ])
  })

  test("a key only the actual snapshot has", () => {
    expect(compareSnapshots({ x: 1 }, { x: 1, y: 2 })).toEqual([
      "y: unexpected key in the actual snapshot",
    ])
  })

  test("a key missing from the actual snapshot", () => {
    expect(compareSnapshots({ x: 1, y: 2 }, { x: 1 })).toEqual([
      "y: missing from the actual snapshot",
    ])
  })

  /**
   * The difference from recording/codec.ts's diffSnapshots, and the reason both
   * exist. This one encodes canonically, so two objects that differ only in key
   * order are the same state and are reported as such.
   */
  test("key order inside a nested value is not a difference", () => {
    expect(
      compareSnapshots({ p: { x: 1, y: 2 } }, { p: { y: 2, x: 1 } }),
    ).toEqual([])
  })

  test("identical snapshots compare equal", () => {
    expect(compareSnapshots({ a: 1, b: [1, 2] }, { a: 1, b: [1, 2] })).toEqual(
      [],
    )
  })
})

describe("comparing checkpoints", () => {
  const at = (tick: number, hash: string): Checkpoint => ({ tick, hash })

  test("the first differing tick is the divergence", () => {
    const divergence = compareCheckpoints(
      [at(60, "a"), at(120, "b"), at(180, "c")],
      [at(60, "a"), at(120, "X"), at(180, "Y")],
    )
    expect(divergence.tick).toBe(120)
    expect(divergence.differences.length).toBe(2)
  })

  test("a checkpoint the replay never wrote says so", () => {
    // "(no checkpoint)" rather than a hash mismatch, because a run that ended
    // early is a different fault from one that computed the wrong state.
    const divergence = compareCheckpoints(
      [at(60, "a"), at(120, "b")],
      [at(60, "a")],
    )
    expect(divergence.tick).toBe(120)
    expect(divergence.differences[0]).toContain("(no checkpoint)")
  })

  /**
   * An extra checkpoint is its own kind of wrong: the replay reached a tick the
   * recording never did. Ignoring it would let a run that simulated further
   * compare equal.
   */
  test("an extra checkpoint in the replay is reported", () => {
    const divergence = compareCheckpoints(
      [at(60, "a")],
      [at(60, "a"), at(120, "b")],
    )
    expect(divergence.tick).toBe(120)
    expect(divergence.differences).toEqual(["tick 120: an extra checkpoint"])
  })

  test("identical lists have no divergence", () => {
    expect(compareCheckpoints([at(60, "a")], [at(60, "a")])).toEqual({
      tick: null,
      differences: [],
    })
  })
})

describe("comparing counters", () => {
  test("a counter that differs", () => {
    expect(compareCounters({ score: 1 }, { score: 2 })).toEqual([
      "score: expected 1, got 2",
    ])
  })

  test("a counter only one side reports", () => {
    expect(compareCounters({ score: 1 }, { score: 1, lives: 3 })).toEqual([
      "lives: expected undefined, got 3",
    ])
  })

  test("counters come out in a stable order", () => {
    expect(
      compareCounters({ b: 1, a: 1 }, { a: 2, b: 2 }).map((d) => d.slice(0, 1)),
    ).toEqual(["a", "b"])
  })
})

describe("comparing whole results", () => {
  function result(over: Partial<SessionResult> = {}): SessionResult {
    return {
      endTick: 600,
      terminal: "ended",
      counters: { score: 10 },
      snapshot: { x: 1 },
      checkpoints: [{ tick: 60, hash: "a" }],
      ...over,
    } as SessionResult
  }

  test("two identical results have nothing to report", () => {
    expect(compareResults(result(), result())).toEqual({
      tick: null,
      differences: [],
    })
  })

  test("an end tick that differs", () => {
    const divergence = compareResults(result(), result({ endTick: 540 }))
    expect(divergence.differences).toContain("endTick: expected 600, got 540")
  })

  test("a terminal reason that differs", () => {
    // Two runs that both ended at tick 600, one because the game ended and one
    // because the tick cap fired, are not the same run.
    const divergence = compareResults(
      result(),
      result({ terminal: "max-ticks" as SessionResult["terminal"] }),
    )
    expect(divergence.differences).toContain(
      "terminal: expected ended, got max-ticks",
    )
  })

  test("a snapshot that differs is only opened when the hashes disagree", () => {
    const divergence = compareResults(result(), result({ snapshot: { x: 2 } }))
    expect(divergence.differences).toContain("x: expected 1, got 2")
  })

  test("everything that differs is reported at once, not the first", () => {
    // A developer fixing a divergence wants the whole picture; reporting one
    // difference at a time is a round trip per fault.
    const divergence = compareResults(
      result(),
      result({
        endTick: 540,
        terminal: "max-ticks" as SessionResult["terminal"],
        counters: { score: 99 },
        snapshot: { x: 2 },
        checkpoints: [{ tick: 60, hash: "z" }],
      }),
    )
    expect(divergence.differences.length).toBeGreaterThanOrEqual(5)
    expect(divergence.tick).toBe(60)
  })
})
