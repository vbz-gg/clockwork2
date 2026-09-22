/**
 * pow where the exponent is enormous.
 *
 * The golden vectors sample a base in [0, 200] and an exponent in [-30, 30],
 * so fdlibm's large-exponent branches have never run. They are not exotic: a
 * decay term like `pow(0.5, elapsedTicks)` reaches them the moment a session
 * runs long enough, and what it gets back decides whether a value underflows
 * to zero or stays finite.
 *
 * Nothing here is an invented expectation. For these arguments ECMAScript
 * specifies the result exactly, so the values are read off the specification
 * rather than off a reference implementation: |x| < 1 with y = +Infinity is
 * +0, |x| > 1 with y = +Infinity is +Infinity, and a huge finite y behaves as
 * the infinity it is indistinguishable from at this magnitude.
 */

import { describe, expect, test } from "bun:test"
import { toBitsHex } from "../../src/bits"
import { pow } from "../../src/dmath/pow"

const HUGE_Y = 2 ** 40
const VAST_Y = 2 ** 70

describe("an exponent past 2^31", () => {
  test("a base inside the unit circle collapses to zero", () => {
    for (const y of [HUGE_Y, VAST_Y]) {
      expect(pow(0.5, y)).toBe(0)
      expect(pow(0.999999, y)).toBe(0)
    }
  })

  test("a base outside it runs away to infinity", () => {
    for (const y of [HUGE_Y, VAST_Y]) {
      expect(pow(1.5, y)).toBe(Number.POSITIVE_INFINITY)
      expect(pow(1.000001, y)).toBe(Number.POSITIVE_INFINITY)
    }
  })

  test("a negative exponent swaps the two", () => {
    for (const y of [HUGE_Y, VAST_Y]) {
      expect(pow(0.5, -y)).toBe(Number.POSITIVE_INFINITY)
      expect(pow(1.5, -y)).toBe(0)
    }
  })

  /**
   * The narrow case between them: |x| so close to 1 that the result is neither
   * 0 nor infinity, and fdlibm computes log(x) from its first few terms rather
   * than from the table. Getting this wrong gives a plausible finite number
   * rather than an obvious one.
   */
  test("a base a hair from one still lands somewhere finite", () => {
    const justUnder = 1 - 2 ** -40
    const justOver = 1 + 2 ** -40
    expect(pow(justUnder, 2 ** 32)).toBeGreaterThan(0)
    expect(pow(justUnder, 2 ** 32)).toBeLessThan(1)
    expect(pow(justOver, 2 ** 32)).toBeGreaterThan(1)
    expect(Number.isFinite(pow(justOver, 2 ** 32))).toBe(true)
  })

  test("and the specified endpoints agree with the infinite case", () => {
    expect(pow(0.5, Number.POSITIVE_INFINITY)).toBe(pow(0.5, VAST_Y))
    expect(pow(1.5, Number.POSITIVE_INFINITY)).toBe(pow(1.5, VAST_Y))
  })
})

describe("a negative base with a large integer exponent", () => {
  /**
   * The parity of y decides the sign, and fdlibm works it out from the bit
   * pattern rather than by a modulo, because y may be far too large for one.
   * Above 2^20 the parity lives in the low word, which is a different branch
   * from the one every small exponent takes. Getting it wrong flips the sign
   * of the answer, which in a simulation is a value moving the wrong way.
   */
  test("an even exponent gives a positive result, an odd one negative", () => {
    for (const k of [21, 25, 31, 40, 51]) {
      const even = 2 ** k
      expect(Math.sign(pow(-1, even))).toBe(1)
      expect(Math.sign(pow(-1, even + 1))).toBe(-1)
    }
  })

  test("the same holds where the exponent needs the low word to say so", () => {
    // 2^30 + 1 and friends: the bit that decides parity is below the top 20
    // bits of the significand, so the high-word shortcut cannot see it.
    for (const y of [2 ** 30 + 1, 2 ** 40 + 1, 2 ** 51 + 1]) {
      expect(Math.sign(pow(-1, y))).toBe(-1)
      expect(Math.sign(pow(-1, y + 1))).toBe(1)
    }
  })

  test("an exponent too large to be odd is treated as even", () => {
    // Past 2^52 a double cannot represent an odd integer at all, so every
    // value there is even and the result is positive.
    expect(Math.sign(pow(-1, 2 ** 53))).toBe(1)
    expect(Math.sign(pow(-1, 2 ** 60))).toBe(1)
  })

  test("a non-integer exponent on a negative base is not a number", () => {
    expect(Number.isNaN(pow(-2, 2 ** 21 + 0.5))).toBe(true)
    expect(Number.isNaN(pow(-2, 0.5))).toBe(true)
  })

  test("a negative base past the unit circle keeps its sign into infinity", () => {
    expect(pow(-2, 2 ** 40)).toBe(Number.POSITIVE_INFINITY)
    expect(pow(-2, 2 ** 40 + 1)).toBe(Number.NEGATIVE_INFINITY)
    expect(toBitsHex(pow(-0.5, 2 ** 40))).toBe(toBitsHex(0))
    expect(toBitsHex(pow(-0.5, 2 ** 40 + 1))).toBe(toBitsHex(-0))
  })
})
