import { describe, expect, test } from "bun:test"
import type { InputEvent } from "../packages/engine/src/contract"
import {
  IDLE,
  measure,
  PEAK_WINDOW,
  peakPerTick,
  SCENARIOS,
} from "./measure-inputs"

/** Ten seconds: long enough for every model player to do its thing. */
const SHORT = 600

const at = (tick: number): InputEvent => ({ tick, code: "a", value: 1 })

describe("the peak rate", () => {
  test("a burst that straddles two fixed windows is still found whole", () => {
    // Two a tick over ticks 60 to 179. Windows fixed at 0 and 120 would each
    // hold half and report 1 a tick.
    const burst = Array.from({ length: 120 }, (_, i) => [
      at(60 + i),
      at(60 + i),
    ]).flat()
    expect(peakPerTick(burst, 18_000)).toBe(2)
  })

  test("a run shorter than the window is held to the whole window", () => {
    expect(peakPerTick([at(0), at(1)], 2)).toBe(2 / PEAK_WINDOW)
  })

  test("an input past the run, or a window of no ticks, is refused", () => {
    expect(() => peakPerTick([at(200)], 200)).toThrow(/past 200 ticks/)
    expect(() => peakPerTick([], 10, 0)).toThrow(/whole number/)
  })
})

describe("the model players", () => {
  // A model player whose events miss the helper measures a recording that is
  // all envelope, and the table would read as a cheap device.
  for (const scenario of SCENARIOS) {
    for (const variant of scenario.variants) {
      test(`${scenario.name}, ${variant.label}: records every input it maps, within the budget`, () => {
        const { row, log } = measure(scenario, variant, SHORT)
        expect(row.ticks).toBe(SHORT)
        expect(new Set(log.map((e) => e.code))).toEqual(
          new Set(Object.keys(variant.inputs)),
        )
        expect(row.withinBudget).toBe(true)
      })
    }
  }

  test("nothing pressed records nothing", () => {
    const [variant] = IDLE.variants
    if (variant === undefined) throw new Error("the baseline has a variant")
    expect(measure(IDLE, variant, SHORT).row.inputs).toBe(0)
  })

  test("a run measures the same twice, so the table can be reproduced", () => {
    const noisy = SCENARIOS.find((s) => s.name === "Tilt in the hand")
    const variant = noisy?.variants[0]
    if (noisy === undefined || variant === undefined) {
      throw new Error("the tilt scenario is gone")
    }
    expect(measure(noisy, variant, SHORT).log).toEqual(
      measure(noisy, variant, SHORT).log,
    )
  })
})
