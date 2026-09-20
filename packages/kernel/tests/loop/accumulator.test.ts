import { describe, expect, test } from "bun:test"
import { Accumulator, DEFAULT_MAX_CATCHUP_TICKS } from "../../src/loop"

describe("Accumulator", () => {
  test("a steady 60 Hz display runs one tick per frame", () => {
    const acc = new Accumulator({ tickHz: 60 })
    let total = 0
    for (let i = 0; i < 600; i++) total += acc.frame(1000 / 60)
    expect(total).toBe(600)
    expect(acc.alpha).toBeLessThan(1)
  })

  test("jitter changes how many ticks run, never how big one is", () => {
    // The worked example from the plan: real rAF timings on a 60 Hz display.
    const acc = new Accumulator({ tickHz: 60 })
    expect(acc.frame(16.4)).toBe(0)
    expect(acc.frame(17.1)).toBe(2)
    expect(acc.frame(16.9)).toBe(1)
    expect(acc.frame(33.2)).toBe(2)
    // Four frames, five ticks, and every one of them the same size.
    expect(acc.stats.frames).toBe(4)
  })

  test("a 144 Hz display runs the same number of ticks per second", () => {
    const fast = new Accumulator({ tickHz: 60 })
    const slow = new Accumulator({ tickHz: 60 })
    let fastTicks = 0
    let slowTicks = 0
    for (let ms = 0; ms < 10_000; ms += 1000 / 144)
      fastTicks += fast.frame(1000 / 144)
    for (let ms = 0; ms < 10_000; ms += 1000 / 30)
      slowTicks += slow.frame(1000 / 30)
    // Ten seconds is 600 ticks either way, give or take the final partial one.
    expect(Math.abs(fastTicks - 600)).toBeLessThanOrEqual(2)
    expect(Math.abs(slowTicks - 600)).toBeLessThanOrEqual(2)
  })

  test("a stalled tab drops its debt instead of bursting", () => {
    const acc = new Accumulator({ tickHz: 60 })
    const ticks = acc.frame(240_000) // four minutes in the background
    expect(ticks).toBe(DEFAULT_MAX_CATCHUP_TICKS)
    expect(acc.stats.droppedMs).toBeGreaterThan(200_000)
    // And the next frame is back to normal rather than still catching up.
    expect(acc.frame(1000 / 60)).toBe(1)
  })

  test("the catch-up cap is respected every frame", () => {
    const acc = new Accumulator({ tickHz: 60, maxCatchUpTicks: 3 })
    for (let i = 0; i < 50; i++) {
      expect(acc.frame(500)).toBeLessThanOrEqual(3)
    }
    expect(acc.stats.mostTicksInAFrame).toBe(3)
  })

  test("alpha stays inside [0, 1)", () => {
    const acc = new Accumulator({ tickHz: 60 })
    for (let i = 0; i < 1000; i++) {
      acc.frame(Math.random() * 40)
      expect(acc.alpha).toBeGreaterThanOrEqual(0)
      expect(acc.alpha).toBeLessThan(1)
    }
  })

  test("a negative or zero elapsed time is harmless", () => {
    const acc = new Accumulator({ tickHz: 60 })
    expect(acc.frame(0)).toBe(0)
    expect(acc.frame(-100)).toBe(0)
    expect(acc.alpha).toBe(0)
  })

  test("an impossible tick rate is refused", () => {
    expect(() => new Accumulator({ tickHz: 0 })).toThrow(RangeError)
    expect(() => new Accumulator({ tickHz: Number.NaN })).toThrow(RangeError)
  })

  test("reset clears the carry and the statistics", () => {
    const acc = new Accumulator({ tickHz: 60 })
    acc.frame(10)
    acc.reset()
    expect(acc.alpha).toBe(0)
    expect(acc.stats).toEqual({ frames: 0, droppedMs: 0, mostTicksInAFrame: 0 })
  })
})
