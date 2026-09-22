/**
 * Identities and monotonicity.
 *
 * These catch a class of error the golden vectors cannot: a golden file
 * regenerated from a broken implementation blesses the break. An identity is
 * checked against mathematics rather than against the last run, so a wrong
 * branch or a swapped constant shows up here first.
 */

import { describe, expect, test } from "bun:test"
import { nextUp, toBitsHex, ulpDistance } from "../../src/bits"
import * as dmath from "../../src/dmath/index"

function lcg(seed: number): () => number {
  let s = seed >>> 0
  return () => {
    s = (Math.imul(s, 1103515245) + 12345) >>> 0
    return s / 4294967296
  }
}

function withinUlp(a: number, b: number, bound: bigint): boolean {
  return ulpDistance(a, b) <= bound
}

describe("trigonometric identities", () => {
  test("sin^2 + cos^2 is 1 across every reduction branch", () => {
    const random = lcg(0xfeed)
    // One sample in each branch of remPio2 plus the ranges between them.
    const ranges: Array<[number, number]> = [
      [-0.7, 0.7],
      [0.7, 2.4],
      [2.4, 1000],
      [1000, 823549],
      [823549, 1e9],
      [1e9, 1e300],
    ]
    for (const [lo, hi] of ranges) {
      for (let i = 0; i < 5000; i++) {
        const x = lo + (hi - lo) * random()
        const s = dmath.sin(x)
        const c = dmath.cos(x)
        expect(
          withinUlp(s * s + c * c, 1, 4n),
          `x=${x} gave ${s * s + c * c}`,
        ).toBe(true)
      }
    }
  })

  test("tan equals sin over cos away from the poles", () => {
    const random = lcg(0xbeef)
    for (let i = 0; i < 20_000; i++) {
      const x = (random() - 0.5) * 100
      const c = dmath.cos(x)
      if (Math.abs(c) < 1e-3) continue
      expect(withinUlp(dmath.tan(x), dmath.sin(x) / c, 6n), `x=${x}`).toBe(true)
    }
  })

  test("sin and cos are odd and even", () => {
    const random = lcg(0x1357)
    for (let i = 0; i < 20_000; i++) {
      const x = (random() - 0.5) * 2000
      expect(toBitsHex(dmath.sin(-x))).toBe(toBitsHex(-dmath.sin(x)))
      expect(toBitsHex(dmath.cos(-x))).toBe(toBitsHex(dmath.cos(x)))
    }
  })

  test("asin undoes sin on [-pi/2, pi/2]", () => {
    const random = lcg(0x2468)
    for (let i = 0; i < 20_000; i++) {
      const x = (random() - 0.5) * Math.PI
      expect(withinUlp(dmath.asin(dmath.sin(x)), x, 1n << 20n), `x=${x}`).toBe(
        true,
      )
    }
  })

  test("asin and acos add to pi/2", () => {
    const random = lcg(0x99aa)
    for (let i = 0; i < 20_000; i++) {
      const x = (random() - 0.5) * 2
      expect(
        withinUlp(dmath.asin(x) + dmath.acos(x), dmath.PI_2, 4n),
        `x=${x}`,
      ).toBe(true)
    }
  })

  test("atan2 agrees with atan in the first quadrant", () => {
    const random = lcg(0x5a5a)
    for (let i = 0; i < 20_000; i++) {
      const y = random() * 100 + 1e-6
      const x = random() * 100 + 1e-6
      expect(
        withinUlp(dmath.atan2(y, x), dmath.atan(y / x), 2n),
        `${y}/${x}`,
      ).toBe(true)
    }
  })

  test("wrapAngle lands in [-pi, pi) and keeps sin unchanged", () => {
    const random = lcg(0x0f0f)
    for (let i = 0; i < 20_000; i++) {
      const x = (random() - 0.5) * 2e9
      const w = dmath.wrapAngle(x)
      expect(w >= -dmath.PI && w < dmath.PI, `wrapAngle(${x}) = ${w}`).toBe(
        true,
      )
      expect(Math.abs(dmath.sin(w) - dmath.sin(x)) < 1e-9, `sin(${x})`).toBe(
        true,
      )
    }
  })
})

describe("exponential and logarithmic identities", () => {
  test("exp undoes log", () => {
    const random = lcg(0x7788)
    for (let i = 0; i < 20_000; i++) {
      const x = Math.exp((random() - 0.5) * 600)
      if (!Number.isFinite(x) || x === 0) continue
      expect(withinUlp(dmath.exp(dmath.log(x)), x, 1n << 12n), `x=${x}`).toBe(
        true,
      )
    }
  })

  test("log turns a product into a sum", () => {
    const random = lcg(0x3344)
    for (let i = 0; i < 20_000; i++) {
      const a = random() * 1e6 + 1e-6
      const b = random() * 1e6 + 1e-6
      expect(
        withinUlp(dmath.log(a * b), dmath.log(a) + dmath.log(b), 1n << 10n),
        `${a} * ${b}`,
      ).toBe(true)
    }
  })

  test("log2 and log10 agree with log at exact powers", () => {
    for (let k = -300; k <= 300; k++) {
      const x = dmath.pow(10, k)
      if (!Number.isFinite(x) || x === 0) continue
      expect(Math.abs(dmath.log10(x) - k) < 1e-9, `log10(1e${k})`).toBe(true)
    }
    for (let k = -1000; k <= 1000; k += 7) {
      const x = dmath.exp2i(Math.max(-1022, Math.min(1023, k)))
      expect(
        Math.abs(dmath.log2(x) - Math.max(-1022, Math.min(1023, k))) < 1e-9,
        `log2(2^${k})`,
      ).toBe(true)
    }
  })
})

describe("pow and ipow", () => {
  test("pow(x, 2) is exactly x*x", () => {
    const random = lcg(0xdead)
    for (let i = 0; i < 20_000; i++) {
      const x = (random() - 0.5) * 1000
      expect(toBitsHex(dmath.pow(x, 2)), `x=${x}`).toBe(toBitsHex(x * x))
    }
  })

  test("pow(x, 0.5) is exactly sqrt(x)", () => {
    const random = lcg(0xcafe)
    for (let i = 0; i < 20_000; i++) {
      const x = random() * 1e6
      expect(toBitsHex(dmath.pow(x, 0.5)), `x=${x}`).toBe(
        toBitsHex(Math.sqrt(x)),
      )
    }
  })

  test("ipow is exact multiplication", () => {
    expect(dmath.ipow(2, 10)).toBe(1024)
    expect(dmath.ipow(1.1, 2)).toBe(1.1 * 1.1)
    expect(dmath.ipow(1.1, 3)).toBe(1.1 * 1.1 * 1.1)
    expect(dmath.ipow(-2, 3)).toBe(-8)
    expect(dmath.ipow(-2, 4)).toBe(16)
    expect(dmath.ipow(5, 0)).toBe(1)
    expect(dmath.ipow(0, 0)).toBe(1)
    expect(dmath.ipow(2, -3)).toBe(1 / 8)
  })

  test("ipow refuses a fractional exponent with a code", () => {
    expect(() => dmath.ipow(2, 0.5)).toThrow(/E_DMATH_RANGE/)
    expect(() => dmath.ipow(2, Number.NaN)).toThrow(/E_DMATH_RANGE/)
    expect(() => dmath.ipow(2, Number.POSITIVE_INFINITY)).toThrow(
      /E_DMATH_RANGE/,
    )
  })

  test("ipow tracks pow for whole exponents", () => {
    const random = lcg(0xbead)
    for (let i = 0; i < 5_000; i++) {
      const x = (random() - 0.5) * 20
      const n = Math.round((random() - 0.5) * 20)
      const a = dmath.ipow(x, n)
      const b = dmath.pow(x, n)
      if (!Number.isFinite(a) || !Number.isFinite(b)) continue
      expect(
        Math.abs(a - b) <= Math.abs(b) * 1e-12,
        `${x}^${n}: ${a} vs ${b}`,
      ).toBe(true)
    }
  })
})

describe("monotonicity near every branch boundary", () => {
  // A wrong branch shows up as a step in the wrong direction at the seam
  // between two code paths, which no random sweep is likely to land on.
  const WINDOWS: Array<[string, number]> = [
    ["zero", 0],
    ["2^-27", 7.450580596923828e-9],
    ["0.3", 0.3],
    ["pi/4", Math.PI / 4],
    ["0.6744", 0.6744],
    ["0.78125", 0.78125],
    ["3pi/4", (3 * Math.PI) / 4],
    ["pi/2", Math.PI / 2],
    ["2^19*pi/2", 823549.6651146304],
  ]

  test("sin rises where it should around each seam", () => {
    for (const [label, centre] of WINDOWS) {
      let x = centre
      for (let i = 0; i < 200; i++) {
        const next = nextUp(x)
        const a = dmath.sin(x)
        const b = dmath.sin(next)
        // One ulp of argument moves sin by at most about one ulp of result.
        expect(
          ulpDistance(a, b) < 1n << 30n,
          `${label}: sin jumped from ${a} to ${b} between ${x} and ${next}`,
        ).toBe(true)
        x = next
      }
    }
  })

  test("exp never steps backwards", () => {
    for (const centre of [-745, -700, -1, -0.5, 0, 0.5, 1, 709, 709.78]) {
      let x = centre
      for (let i = 0; i < 500; i++) {
        const next = nextUp(x)
        expect(dmath.exp(next) >= dmath.exp(x), `exp at ${x}`).toBe(true)
        x = next
      }
    }
  })

  test("log never steps backwards", () => {
    for (const centre of [
      Number.MIN_VALUE,
      1e-320,
      1e-300,
      0.5,
      1,
      1.5,
      2,
      1e300,
    ]) {
      let x = centre
      for (let i = 0; i < 500; i++) {
        const next = nextUp(x)
        if (!Number.isFinite(next)) break
        expect(dmath.log(next) >= dmath.log(x), `log at ${x}`).toBe(true)
        x = next
      }
    }
  })
})
