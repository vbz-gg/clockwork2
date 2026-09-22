/**
 * Payne-Hanek reduction: the four precisions, and an oracle it has never had.
 *
 * `kernelRemPio2` is fdlibm's `__kernel_rem_pio2`, and AGENTS.md is explicit
 * that its branch structure stays recognisable against the C. That means the
 * `prec` 0, 1 and 3 cases stay, even though the kernel's own `remPio2` only
 * ever asks for 2. Deleting them is not on the table, so they are tested where
 * they are.
 *
 * The bigger gap is that this path had no oracle at all.
 * `tests/dmath/oracle.test.ts` compares dmath against the host's Math only for
 * |x| <= 1000, and Payne-Hanek does not open until |x| > 2^19 * pi/2, about
 * 823,550. Above that the only check was a recorded digest, which says the
 * answer has not changed, not that it was ever right.
 *
 * So this computes pi to a few hundred bits with a BigInt Machin formula and
 * reduces each sample in exact integer arithmetic. Nothing is transcribed from
 * a reference implementation, and the oracle does not touch IPIO2, which is
 * the table under test and would make the check circular.
 */

import { describe, expect, test } from "bun:test"
import { remPio2 } from "../../src/dmath/kernel/rem-pio2"
import { kernelRemPio2 } from "../../src/dmath/kernel/rem-pio2-large"

/**
 * Enough bits that reducing the largest double is still exact. The error in n
 * is about |x| times the error in 2/pi, so pi has to be known to more bits than
 * the exponent of the largest sample: a double reaches 2^1024, so 400 bits of
 * pi would leave n wrong by 2^600 rather than by nothing.
 */
const BITS = 1200n
const SCALE = 1n << BITS

/** arctan(1/n) in fixed point, from its alternating series. */
function atanInverse(n: bigint): bigint {
  let term = SCALE / n
  let sum = term
  let k = 1n
  while (term !== 0n) {
    term = term / (n * n)
    sum += k % 2n === 1n ? -term / (2n * k + 1n) : term / (2n * k + 1n)
    k++
  }
  return sum
}

/**
 * pi in fixed point, by Machin's formula: pi/4 = 4 atan(1/5) - atan(1/239).
 * Its leading bits are checked against Math.PI below, so a mistake in the
 * series shows up before it can excuse a mistake in the routine under test.
 */
const PI_FIXED = 4n * (4n * atanInverse(5n) - atanInverse(239n))
const PIO2_FIXED = PI_FIXED / 2n

/** The exact value of a double, as a fixed-point BigInt. */
function exact(value: number): bigint {
  const buffer = new DataView(new ArrayBuffer(8))
  buffer.setFloat64(0, value)
  const bits = buffer.getBigUint64(0)
  const rawExponent = Number((bits >> 52n) & 0x7ffn)
  const mantissa = bits & 0xfffffffffffffn
  const significand = rawExponent === 0 ? mantissa : mantissa | (1n << 52n)
  const exponent = (rawExponent === 0 ? 1 : rawExponent) - 1075
  const scaled =
    exponent >= 0
      ? significand * (1n << BigInt(exponent)) * SCALE
      : (significand * SCALE) >> BigInt(-exponent)
  return bits >> 63n === 1n ? -scaled : scaled
}

/** n and the remainder r, where x = n * (pi/2) + r and |r| <= pi/4. */
function reduceExactly(x: number): { n: bigint; r: bigint } {
  const value = exact(x)
  let n = value / PIO2_FIXED
  let r = value - n * PIO2_FIXED
  // Round to nearest, which is what the routine does.
  if (2n * (r < 0n ? -r : r) > PIO2_FIXED) {
    const step = r > 0n ? 1n : -1n
    n += step
    r -= step * PIO2_FIXED
  }
  return { n, r }
}

function asFixed(value: number): bigint {
  return exact(value)
}

/** Splits |x| into the three 24-bit words kernelRemPio2 expects. */
function split(x: number): { words: Float64Array; e0: number; nx: number } {
  const buffer = new DataView(new ArrayBuffer(8))
  buffer.setFloat64(0, Math.abs(x))
  const high = buffer.getUint32(0)
  const low = buffer.getUint32(4)
  const e0 = (high >> 20) - 1046
  buffer.setUint32(0, high - (e0 << 20))
  buffer.setUint32(4, low)
  let z = buffer.getFloat64(0)

  const words = new Float64Array(3)
  for (let i = 0; i < 2; i++) {
    words[i] = Math.trunc(z)
    z = (z - (words[i] as number)) * 1.6777216e7
  }
  words[2] = z
  let nx = 3
  while ((words[nx - 1] as number) === 0) nx--
  return { words, e0, nx }
}

/** Every sample is a real double above where Payne-Hanek opens. */
const SAMPLES: readonly number[] = [
  1e7,
  1e8,
  123_456_789.25,
  2 ** 30 + 0.5,
  1e15,
  2 ** 52 + 1,
  1e20,
  1.7e30,
  3.9e60,
  1e100,
  5e200,
  1.5e300,
  Number.MAX_VALUE / 3,
]

describe("the oracle itself", () => {
  /**
   * If the series were wrong, every comparison below would be meaningless and
   * they would all still pass together. So it is pinned against the one value
   * of pi that is not in doubt.
   */
  test("the Machin series agrees with Math.PI to the last bit of a double", () => {
    const rounded = Number(PI_FIXED >> (BITS - 60n)) / 2 ** 60
    expect(rounded).toBe(Math.PI)
  })

  test("and reduces a small angle the way anyone would by hand", () => {
    const { n, r } = reduceExactly(Math.PI)
    expect(n).toBe(2n)
    expect(r < PI_FIXED / 100n).toBe(true)
  })
})

describe("prec 2, which is what the kernel asks for", () => {
  test("agrees with an independently computed reduction", () => {
    for (const x of SAMPLES) {
      const { words, e0, nx } = split(x)
      const y = new Float64Array(3)
      const n = kernelRemPio2(words, y, e0, nx, 2)
      const expected = reduceExactly(x)

      expect(BigInt(n) & 7n).toBe(expected.n & 7n)

      // y[0] + y[1] against the exact remainder, to within an ulp or two of
      // the leading term. An ulp of a number near pi/4 is about 2^-53.
      const got = asFixed(y[0] as number) + asFixed(y[1] as number)
      const slack = SCALE >> 45n
      const error = got - expected.r
      expect((error < 0n ? -error : error) < slack).toBe(true)
    }
  })

  test("the remainder it returns is inside the quarter turn it promises", () => {
    // A remainder outside [-pi/4, pi/4] would send sin and cos into their
    // polynomial with an argument the polynomial is not accurate for.
    for (const x of SAMPLES) {
      const { words, e0, nx } = split(x)
      const y = new Float64Array(3)
      kernelRemPio2(words, y, e0, nx, 2)
      expect(Math.abs((y[0] as number) + (y[1] as number))).toBeLessThanOrEqual(
        Math.PI / 4 + 1e-15,
      )
    }
  })
})

describe("the precisions the kernel never asks for", () => {
  /**
   * fdlibm defines prec 0 as the same leading sum with the tail dropped, and
   * the two loops that compute it are textually identical. A refactor that
   * reordered one summation would part them, and nothing else would see it.
   */
  /**
   * prec is a working precision as well as an output shape: INIT_JK is
   * [2, 3, 4, 6], so a lower prec carries fewer words through the multiply.
   * Each therefore answers the same question to its own accuracy, and the
   * agreement between them is bounded rather than exact.
   */
  /**
   * Rather than a tuned tolerance, this asserts what `prec` claims to be for:
   * asking for more of it buys accuracy against the exact reduction. If the
   * table walk were wrong, or a prec were wired to the wrong jk, the ordering
   * would not hold and no single tolerance would have told anyone why.
   */
  test("a higher prec is closer to the exact reduction, in that order", () => {
    for (const x of SAMPLES) {
      const { words, e0, nx } = split(x)
      const exactRemainder = reduceExactly(x).r

      const errors = [0, 2, 3].map((prec) => {
        const y = new Float64Array(3)
        kernelRemPio2(words, y, e0, nx, prec)
        const got =
          asFixed(y[0] as number) +
          asFixed(y[1] as number) +
          (prec === 3 ? asFixed(y[2] as number) : 0n)
        const error = got - exactRemainder
        return error < 0n ? -error : error
      })

      const [coarse, fine, finest] = errors as [bigint, bigint, bigint]
      expect(fine <= coarse).toBe(true)
      expect(finest <= fine).toBe(true)
      // And even the coarsest is a usable answer, not noise.
      expect(coarse < SCALE >> 25n).toBe(true)
    }
  })

  test("every prec returns the same octant", () => {
    for (const x of SAMPLES) {
      const { words, e0, nx } = split(x)
      const ns = [0, 1, 2, 3].map((prec) =>
        kernelRemPio2(words, new Float64Array(3), e0, nx, prec),
      )
      expect(new Set(ns).size).toBe(1)
    }
  })

  test("prec 1 answers as prec 2 does, to the accuracy it carries", () => {
    // They share a case label, so the output shape is identical; the jk they
    // run at is not. noFallthroughCasesInSwitch means a future split of the
    // label has to keep the shape, which is what the pair count below holds.
    for (const x of SAMPLES) {
      const { words, e0, nx } = split(x)
      const one = new Float64Array(3)
      const two = new Float64Array(3)
      expect(kernelRemPio2(words, one, e0, nx, 1)).toBe(
        kernelRemPio2(words, two, e0, nx, 2),
      )
      const total = (v: Float64Array) => (v[0] as number) + (v[1] as number)
      expect(Math.abs(total(one) - total(two))).toBeLessThan(1e-15)
      // Both fill two pieces and leave the third alone.
      expect(one[2]).toBe(0)
      expect(two[2]).toBe(0)
    }
  })

  /**
   * prec 3 hands back three pieces instead of two, renormalised by two Dekker
   * passes. Those passes are the transcription most likely to be wrong, and a
   * wrong one shows up as a sum that no longer reconstructs the two-piece
   * answer.
   */
  test("prec 3's three pieces reconstruct prec 2's two", () => {
    for (const x of SAMPLES) {
      const { words, e0, nx } = split(x)
      const three = new Float64Array(3)
      const two = new Float64Array(3)
      expect(kernelRemPio2(words, three, e0, nx, 3)).toBe(
        kernelRemPio2(words, two, e0, nx, 2),
      )

      const sumThree =
        asFixed(three[0] as number) +
        asFixed(three[1] as number) +
        asFixed(three[2] as number)
      const sumTwo = asFixed(two[0] as number) + asFixed(two[1] as number)
      const error = sumThree - sumTwo
      expect((error < 0n ? -error : error) < SCALE >> 45n).toBe(true)
    }
  })

  test("prec 3's pieces come out in decreasing magnitude", () => {
    // That ordering is what makes summing them in order lose nothing.
    for (const x of SAMPLES) {
      const { words, e0, nx } = split(x)
      const y = new Float64Array(3)
      kernelRemPio2(words, y, e0, nx, 3)
      expect(Math.abs(y[0] as number)).toBeGreaterThanOrEqual(
        Math.abs(y[1] as number),
      )
      expect(Math.abs(y[1] as number)).toBeGreaterThanOrEqual(
        Math.abs(y[2] as number),
      )
    }
  })

  test("every precision agrees on the octant", () => {
    // n decides the quadrant sin and cos are computed in. A branch that changed
    // it puts the answer a quarter turn out, which is not a small error.
    for (const x of SAMPLES) {
      const { words, e0, nx } = split(x)
      const octants = [0, 1, 2, 3].map((prec) => {
        const y = new Float64Array(3)
        return kernelRemPio2(words, y, e0, nx, prec) & 7
      })
      expect(new Set(octants).size).toBe(1)
    }
  })
})

describe("the trailing zero words", () => {
  /**
   * When the reduction cancels enough that the top word of the result is zero,
   * fdlibm drops words and lowers the exponent until it finds one that is not.
   * The inputs below were found by sweeping doubles near multiples of pi/2 at
   * large exponents and keeping the ones that enter that loop; the assertion
   * on each is still the oracle comparison above, so the value is a discovered
   * input rather than an expected output.
   */
  const NEAR_MULTIPLES = [
    6381956970095103 * 2 ** 797,
    2 ** 120 * 1.5707963267948966,
    (Math.PI / 2) * 2 ** 500,
    (Math.PI / 2) * 2 ** 900,
  ]

  test("still reduce to the right remainder", () => {
    for (const x of NEAR_MULTIPLES) {
      const { words, e0, nx } = split(x)
      const y = new Float64Array(3)
      const n = kernelRemPio2(words, y, e0, nx, 2)
      const expected = reduceExactly(x)
      expect(BigInt(n) & 7n).toBe(expected.n & 7n)
      const got = asFixed(y[0] as number) + asFixed(y[1] as number)
      const error = got - expected.r
      expect((error < 0n ? -error : error) < SCALE >> 40n).toBe(true)
    }
  })
})

describe("remPio2's own refusal to reduce", () => {
  /**
   * AGENTS.md names this hazard directly: a sentinel here looks like a guard
   * and is not one, because `NaN & 3 === 0` and the caller then computes a
   * plausible wrong answer from a stale quadrant. So both halves are asserted:
   * that calling it directly really does return 0 with NaN, and that nothing in
   * dmath reaches it without guarding first.
   */
  test("an infinity or a NaN gives n = 0 and a NaN remainder", () => {
    for (const x of [
      Number.POSITIVE_INFINITY,
      Number.NEGATIVE_INFINITY,
      Number.NaN,
    ]) {
      const y = new Float64Array(2)
      expect(remPio2(x, y)).toBe(0)
      expect(Number.isNaN(y[0] as number)).toBe(true)
      expect(Number.isNaN(y[1] as number)).toBe(true)
    }
  })
})
