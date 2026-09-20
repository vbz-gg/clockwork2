import { describe, expect, test } from "bun:test"
import * as fixed from "../../src/fixed"

describe("fixed point", () => {
  test("numbers round trip within the resolution", () => {
    for (const value of [0, 1, -1, 0.5, -0.5, 100.25, -9999.5, 32767, -32768]) {
      const back = fixed.toNumber(fixed.fromNumber(value))
      expect(Math.abs(back - value), String(value)).toBeLessThanOrEqual(
        1 / 65536,
      )
    }
  })

  test("integers are exact", () => {
    for (let i = -1000; i <= 1000; i++) {
      expect(fixed.toInt(fixed.fromInt(i))).toBe(i)
    }
  })

  test("addition and subtraction are exact", () => {
    const a = fixed.fromNumber(1.5)
    const b = fixed.fromNumber(2.25)
    expect(fixed.toNumber(fixed.add(a, b))).toBe(3.75)
    expect(fixed.toNumber(fixed.sub(a, b))).toBe(-0.75)
  })

  test("multiplication and division stay inside one step", () => {
    const a = fixed.fromNumber(1.5)
    const b = fixed.fromNumber(2.5)
    expect(fixed.toNumber(fixed.mul(a, b))).toBeCloseTo(3.75, 4)
    expect(fixed.toNumber(fixed.div(a, b))).toBeCloseTo(0.6, 4)
    expect(() => fixed.div(a, 0)).toThrow(/E_ARG_INVALID/)
  })

  test("the same operations give the same bits every time", () => {
    // The whole point: no rounding to reason about, so equality means what it
    // looks like it means.
    let acc = fixed.fromNumber(0.1)
    const step = fixed.fromNumber(0.1)
    for (let i = 0; i < 1000; i++) acc = fixed.add(acc, step)
    let again = fixed.fromNumber(0.1)
    for (let i = 0; i < 1000; i++) again = fixed.add(again, step)
    expect(acc).toBe(again)
  })

  test("rounding helpers", () => {
    expect(fixed.toNumber(fixed.floor(fixed.fromNumber(1.75)))).toBe(1)
    expect(fixed.toNumber(fixed.ceil(fixed.fromNumber(1.25)))).toBe(2)
    expect(fixed.toNumber(fixed.round(fixed.fromNumber(1.5)))).toBe(2)
    expect(fixed.toNumber(fixed.round(fixed.fromNumber(1.4)))).toBe(1)
    expect(fixed.toNumber(fixed.abs(fixed.fromNumber(-3.5)))).toBe(3.5)
  })

  test("min, max, clamp and lerp", () => {
    const a = fixed.fromNumber(2)
    const b = fixed.fromNumber(8)
    expect(fixed.min(a, b)).toBe(a)
    expect(fixed.max(a, b)).toBe(b)
    expect(fixed.clamp(fixed.fromNumber(10), a, b)).toBe(b)
    expect(fixed.clamp(fixed.fromNumber(0), a, b)).toBe(a)
    expect(fixed.toNumber(fixed.lerp(a, b, fixed.FIXED_ONE >> 1))).toBeCloseTo(
      5,
      4,
    )
  })

  test("square root", () => {
    for (const value of [0, 1, 2, 4, 9, 100, 1000]) {
      const result = fixed.toNumber(fixed.sqrt(fixed.fromNumber(value)))
      expect(Math.abs(result - Math.sqrt(value)), String(value)).toBeLessThan(
        0.01,
      )
    }
    expect(() => fixed.sqrt(fixed.fromNumber(-1))).toThrow(/E_ARG_INVALID/)
  })
})
