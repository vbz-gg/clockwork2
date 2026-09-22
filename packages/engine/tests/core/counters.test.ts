import { describe, expect, test } from "bun:test"
import {
  type CounterDeclaration,
  CounterTracker,
  compareByRank,
  meetsThreshold,
} from "../../src/counters"

const DECLARED: readonly CounterDeclaration[] = [
  { name: "score", direction: "up", monotonic: true },
  { name: "ticks", direction: "up", monotonic: true },
  { name: "lives", direction: "down", monotonic: false },
]

describe("CounterTracker", () => {
  test("accepts a run whose counters only go the declared way", () => {
    const tracker = new CounterTracker(DECLARED)
    for (let tick = 1; tick <= 10; tick++) {
      tracker.check({ score: tick * 2, ticks: tick, lives: 3 }, false, tick)
    }
    expect(() =>
      tracker.check({ score: 20, ticks: 11, lives: 2 }, true, 11),
    ).not.toThrow()
  })

  test("a monotone counter may not reverse", () => {
    const tracker = new CounterTracker(DECLARED)
    tracker.check({ score: 10, ticks: 1, lives: 3 }, false, 1)
    expect(() =>
      tracker.check({ score: 9, ticks: 2, lives: 3 }, false, 2),
    ).toThrow(/E_COUNTER_REVERSED/)
  })

  test("a counter that is not monotone may move either way", () => {
    const tracker = new CounterTracker(DECLARED)
    tracker.check({ score: 1, ticks: 1, lives: 3 }, false, 1)
    expect(() =>
      tracker.check({ score: 1, ticks: 2, lives: 1 }, false, 2),
    ).not.toThrow()
    expect(() =>
      tracker.check({ score: 1, ticks: 3, lives: 3 }, false, 3),
    ).not.toThrow()
  })

  test("a value that is not a whole number inside 53 bits is refused", () => {
    const tracker = new CounterTracker(DECLARED)
    for (const bad of [1.5, Number.NaN, Number.POSITIVE_INFINITY, 2 ** 54]) {
      const fresh = new CounterTracker(DECLARED)
      expect(
        () => fresh.check({ score: bad, ticks: 1, lives: 3 }, false, 1),
        String(bad),
      ).toThrow(/E_COUNTER_RANGE/)
    }
    expect(() =>
      tracker.check({ score: 0, ticks: 0, lives: 0 }, false, 1),
    ).not.toThrow()
  })

  test("a missing or undeclared counter is refused", () => {
    const tracker = new CounterTracker(DECLARED)
    expect(() => tracker.check({ score: 1, ticks: 1 }, false, 1)).toThrow(
      /E_COUNTER_RANGE.*missing/s,
    )
    const other = new CounterTracker(DECLARED)
    expect(() =>
      other.check({ score: 1, ticks: 1, lives: 1, bonus: 5 }, false, 1),
    ).toThrow(/E_COUNTER_RANGE.*does not declare/s)
  })

  test("isOver may not go back to false", () => {
    const tracker = new CounterTracker(DECLARED)
    tracker.check({ score: 1, ticks: 1, lives: 3 }, true, 1)
    expect(() =>
      tracker.check({ score: 1, ticks: 2, lives: 3 }, false, 2),
    ).toThrow(/E_OVER_FLIPPED/)
  })

  test("a counter declared twice is refused when the tracker is built", () => {
    expect(
      () =>
        new CounterTracker([
          { name: "score", direction: "up", monotonic: true },
          { name: "score", direction: "down", monotonic: false },
        ]),
    ).toThrow(/E_MANIFEST_INVALID/)
  })
})

describe("thresholds and ranking", () => {
  test("an objective is one comparison, not an operator table", () => {
    expect(meetsThreshold({ score: 100 }, "score", 100)).toBe(true)
    expect(meetsThreshold({ score: 99 }, "score", 100)).toBe(false)
    expect(meetsThreshold({ score: 100 }, "combo", 1)).toBe(false)
  })

  test("ranking follows each counter's declared direction", () => {
    const a = { score: 10, ticks: 500, lives: 1 }
    const b = { score: 10, ticks: 300, lives: 1 }
    // Higher score wins; on a tie, fewer ticks wins.
    expect(
      compareByRank(
        a,
        b,
        ["score", "ticks"],
        [
          { name: "score", direction: "up", monotonic: true },
          { name: "ticks", direction: "down", monotonic: true },
        ],
      ),
    ).toBeGreaterThan(0)
  })

  test("two identical results tie", () => {
    const counters = { score: 5, ticks: 5 }
    expect(compareByRank(counters, { ...counters }, ["score"], DECLARED)).toBe(
      0,
    )
  })

  test("ranking by something that is not a declared counter is refused", () => {
    expect(() => compareByRank({}, {}, ["nope"], DECLARED)).toThrow(
      /E_MANIFEST_INVALID/,
    )
  })
})
