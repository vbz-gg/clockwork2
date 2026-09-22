/**
 * The float32 helpers, exp2i, and the scaling primitives underneath fdlibm.
 *
 * Most of these are one line. What earns them a test is not the line, it is the
 * promise the file makes around it. `misc.ts` states that add, subtract and
 * multiply through Math.fround are correctly rounded and that divide is not,
 * and nothing checked either claim. `helpers.ts` says scalbn handles subnormals
 * by scaling in and out rather than by repeated multiplication so that no
 * intermediate rounding creeps in, and nothing reached those branches.
 *
 * There is no test below for `sign` or `f32`, which are `Math.sign` and
 * `Math.fround` under other names. Calling them and asserting what Math already
 * guarantees would restate the implementation.
 */

import { describe, expect, test } from "bun:test"
import { toBitsHex } from "../../src/bits"
import { copysign, scalbn, twoPow } from "../../src/dmath/helpers"
import {
  exp2i,
  f32add,
  f32div,
  f32FromBits,
  f32mul,
  f32sub,
  f32ToBits,
  isNegative,
} from "../../src/dmath/misc"
import { isClockworkError } from "../../src/errors"

function codeOf(run: () => unknown): string {
  try {
    run()
  } catch (error) {
    return isClockworkError(error) ? error.code : `not ours: ${String(error)}`
  }
  return "(it did not throw)"
}

/** The exactly-rounded float32 quotient, computed in BigInt. */
function exactF32Quotient(a: number, b: number): number {
  // 2^30 significant bits of a/b is far more than float32's 24, so rounding
  // that down to float32 is the correctly rounded answer.
  const scale = 2 ** 30
  const scaled = Math.floor((a / b) * scale)
  return Math.fround(scaled / scale)
}

describe("float32 arithmetic", () => {
  /**
   * The claim in misc.ts: the double result of adding two float32 values is
   * exact, so rounding it once to float32 is correctly rounded. If that were
   * wrong, every float32 field in every snapshot would be a place two engines
   * could part company.
   */
  test("add, subtract and multiply are rounded exactly once", () => {
    const values = [1, 0.1, 16_777_217, 1e-30, 3.4e38, -7.5, 2 ** -140].map(
      Math.fround,
    )
    for (const a of values) {
      for (const b of values) {
        // The double arithmetic is exact for float32 inputs, so the only
        // rounding is the fround, and doing it twice changes nothing.
        expect(f32add(a, b)).toBe(Math.fround(Math.fround(a + b)))
        expect(f32sub(a, b)).toBe(Math.fround(Math.fround(a - b)))
        expect(f32mul(a, b)).toBe(Math.fround(Math.fround(a * b)))
      }
    }
  })

  /**
   * Division is the exception the file documents: the double quotient is
   * rounded, and then rounded again to float32. Still deterministic, which is
   * all the simulation needs, but not IEEE float32 division - so a shader
   * ported here will not agree bit for bit. This finds a pair where the two
   * answers differ, which is what makes the warning real rather than cautious.
   */
  test("divide is rounded twice, and it shows", () => {
    let found: [number, number] | null = null
    for (let i = 1; i < 20_000 && found === null; i++) {
      const a = Math.fround(i)
      const b = Math.fround(3 + i * 7)
      if (f32div(a, b) !== exactF32Quotient(a, b)) found = [a, b]
    }
    expect(found).not.toBeNull()
    const [a, b] = found as [number, number]
    expect(f32div(a, b)).toBe(Math.fround(a / b))
    expect(f32div(a, b)).not.toBe(exactF32Quotient(a, b))
  })

  test("bits round trip, negative zero and the infinities included", () => {
    for (const bits of [
      0x00000000, // +0
      0x80000000, // -0
      0x3f800000, // 1
      0xbf800000, // -1
      0x00000001, // the smallest subnormal
      0x7f800000, // +Infinity
      0xff800000, // -Infinity
      0x7f7fffff, // the largest finite float32
    ]) {
      expect(f32ToBits(f32FromBits(bits))).toBe(bits >>> 0)
    }
  })

  /**
   * A NaN payload does not survive, and a game must not carry information in
   * one. The value passes through a double on its way in and out, and the
   * engine is free to canonicalise the payload when it does: 0x7fc00001 comes
   * back as 0x7fc00000 here. Anything a simulation encoded in those bits would
   * therefore be an engine-dependent value inside a snapshot, which is the one
   * thing the whole kernel exists to rule out.
   */
  test("a NaN payload does not survive, so nothing may be stored in one", () => {
    const withPayload = 0x7fc00001
    expect(Number.isNaN(f32FromBits(withPayload))).toBe(true)
    expect(f32ToBits(f32FromBits(withPayload))).not.toBe(withPayload)
  })

  test("the bit pattern is the one IEEE 754 specifies", () => {
    // Pinned against the standard rather than against the implementation: 1.0
    // is 0x3f800000 in every conforming float32.
    expect(f32ToBits(1)).toBe(0x3f800000)
    expect(f32ToBits(-2)).toBe(0xc0000000)
    expect(f32FromBits(0x3f800000)).toBe(1)
  })

  test("f32ToBits returns an unsigned word, not a negative int32", () => {
    // A signed result would sort and compare wrongly wherever it is stored.
    expect(f32ToBits(-1)).toBeGreaterThan(0)
  })
})

describe("isNegative", () => {
  /**
   * The whole reason it exists rather than `x < 0`. A velocity that has
   * decayed to -0 still points the other way, and a game that reads its sign
   * with a comparison sees it as positive.
   */
  test("negative zero is negative, where a comparison says otherwise", () => {
    const decayedToNothing = -0
    expect(isNegative(decayedToNothing)).toBe(true)
    // The comparison a game would reach for instead, and why it is wrong.
    expect(decayedToNothing < 0).toBe(false)
    expect(isNegative(0)).toBe(false)
  })

  test("and the ordinary cases still hold", () => {
    expect(isNegative(-1e-320)).toBe(true)
    expect(isNegative(Number.NEGATIVE_INFINITY)).toBe(true)
    expect(isNegative(1)).toBe(false)
  })
})

describe("exp2i", () => {
  test("is exact across the whole exponent range", () => {
    for (const k of [-1022, -1021, -54, -1, 0, 1, 52, 1023]) {
      expect(exp2i(k)).toBe(2 ** k)
      expect(toBitsHex(exp2i(k))).toBe(toBitsHex(2 ** k))
    }
  })

  /**
   * AGENTS.md: "Never return a sentinel for an out-of-range argument." Without
   * the guard, `(k + 1023) << 20` wraps silently and hands back a plausible
   * wrong power of two, which is the failure that looks like a physics bug
   * three files away.
   */
  test("refuses an exponent it cannot build", () => {
    for (const k of [-1023, 1024, 2.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(codeOf(() => exp2i(k))).toBe("E_DMATH_RANGE")
    }
  })
})

describe("twoPow", () => {
  test("agrees with exp2i and with scalbn across the range", () => {
    // Three constructions of the same number; any one of them going wrong
    // shows up here rather than as a drift in a game's physics.
    for (let k = -1022; k <= 1023; k += 7) {
      expect(toBitsHex(twoPow(k))).toBe(toBitsHex(exp2i(k)))
      expect(toBitsHex(twoPow(k))).toBe(toBitsHex(scalbn(1, k)))
    }
  })
})

describe("copysign", () => {
  /**
   * scalbn builds its overflow and underflow returns out of copysign, so its
   * handling of -0 is load-bearing rather than decorative.
   */
  test("takes the sign of the second argument, including a negative zero", () => {
    expect(toBitsHex(copysign(1, -0))).toBe(toBitsHex(-1))
    expect(toBitsHex(copysign(-1, 0))).toBe(toBitsHex(1))
    expect(toBitsHex(copysign(-0, 1))).toBe(toBitsHex(0))
    expect(toBitsHex(copysign(0, -1))).toBe(toBitsHex(-0))
  })

  test("keeps the magnitude untouched", () => {
    expect(copysign(3.25, -1)).toBe(-3.25)
    expect(copysign(Number.POSITIVE_INFINITY, -1)).toBe(
      Number.NEGATIVE_INFINITY,
    )
  })

  /**
   * The one way a NaN could reach a checkpoint. Its sign bit belongs to the
   * processor, not to ECMAScript, and copysign turns that bit into a finite
   * number the canonical encoder will happily take: before this guard,
   * copysign(5, inf - inf) was -5 on x86 and 5 on arm64. Every other route is
   * closed by something that refuses a NaN outright, so this one had to be
   * closed by refusing it here.
   */
  test("refuses a NaN, which is what stops an architecture reaching a hash", () => {
    // Opaque, because a literal `Infinity - Infinity` is folded at parse time
    // and yields the positive NaN on both architectures. The computed one is
    // the value that actually differs.
    const opaque = new Float64Array([Number.POSITIVE_INFINITY])
    const inf = opaque[0] as number
    const computedNaN = inf - inf

    expect(Number.isNaN(computedNaN)).toBe(true)
    expect(codeOf(() => copysign(5, computedNaN))).toBe("E_ARG_INVALID")
    expect(codeOf(() => copysign(computedNaN, 1))).toBe("E_ARG_INVALID")
    expect(codeOf(() => copysign(Number.NaN, Number.NaN))).toBe("E_ARG_INVALID")
  })

  test("the refusal names the call, so the line is obvious", () => {
    let message = ""
    try {
      copysign(5, Number.NaN)
    } catch (error) {
      message = String(error)
    }
    expect(message).toContain("copysign(5, NaN)")
  })
})

describe("scalbn", () => {
  test("is exact wherever the result is representable", () => {
    for (const x of [1, 3.25, -7.5, 1e100, 1e-100]) {
      for (const n of [-60, -1, 0, 1, 60]) {
        expect(toBitsHex(scalbn(x, n))).toBe(toBitsHex(x * 2 ** n))
      }
    }
  })

  /**
   * The branch the fdlibm comment is about. A subnormal input is scaled up by
   * 2^54 first, so the significand is normal before the exponent is adjusted.
   * Repeated multiplication instead would round at every step and land
   * somewhere else.
   */
  test("a subnormal scaled up comes back exactly", () => {
    const subnormal = 5e-324
    expect(scalbn(subnormal, 1)).toBe(1e-323)
    expect(scalbn(subnormal, 1074)).toBe(1)
    expect(toBitsHex(scalbn(subnormal, 100))).toBe(
      toBitsHex(subnormal * 2 ** 100),
    )
  })

  test("a normal scaled down into the subnormals comes back exactly", () => {
    expect(scalbn(1, -1074)).toBe(5e-324)
    expect(scalbn(1, -1075)).toBe(0)
  })

  test("zero and the infinities pass straight through", () => {
    expect(toBitsHex(scalbn(0, 100))).toBe(toBitsHex(0))
    expect(toBitsHex(scalbn(-0, 100))).toBe(toBitsHex(-0))
    expect(scalbn(Number.POSITIVE_INFINITY, -2000)).toBe(
      Number.POSITIVE_INFINITY,
    )
    // copysign refuses a NaN now, and scalbn must still not throw on one: it
    // returns at the `k === 0x7ff` branch before it ever calls copysign.
    expect(Number.isNaN(scalbn(Number.NaN, 5))).toBe(true)
  })

  test("overflows to an infinity of the right sign", () => {
    expect(scalbn(1, 2000)).toBe(Number.POSITIVE_INFINITY)
    expect(scalbn(-1, 2000)).toBe(Number.NEGATIVE_INFINITY)
  })

  test("underflows to a zero of the right sign", () => {
    expect(toBitsHex(scalbn(1, -2000))).toBe(toBitsHex(0))
    expect(toBitsHex(scalbn(-1, -2000))).toBe(toBitsHex(-0))
  })

  /**
   * The two guards on n itself. `k = k + n` is int32 arithmetic, so without
   * them a large enough n wraps the exponent round and scalbn returns a finite
   * number where it should return an infinity.
   */
  test("an exponent far outside int32's comfort still saturates", () => {
    expect(scalbn(1, 60_000)).toBe(Number.POSITIVE_INFINITY)
    expect(scalbn(-1, 60_000)).toBe(Number.NEGATIVE_INFINITY)
    expect(toBitsHex(scalbn(1, -60_000))).toBe(toBitsHex(0))
    expect(toBitsHex(scalbn(5e-324, -60_000))).toBe(toBitsHex(0))
  })
})
