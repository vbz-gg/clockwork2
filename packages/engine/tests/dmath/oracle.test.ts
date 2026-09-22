/**
 * dmath against the host's own `Math`.
 *
 * This is a sanity check, not a correctness proof, and the direction of the
 * comparison matters. `Math.sin` and the rest are implementation-defined, so
 * the host is not an authority: where the two disagree by a rounding step, it
 * is as likely the host that is loose as us. What this catches is a
 * transcription error, which shows up as a large difference or a wrong
 * special case rather than a last-bit one.
 *
 * Bounds are per routine, and they say as much about the host's library as
 * about ours. V8 tracks fdlibm closely for the trigonometric and exponential
 * families, so those are tight. `Math.pow` is a different algorithm in every
 * engine, and JavaScriptCore's is several steps from fdlibm's, so that bound
 * is loose on purpose.
 */

import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { fromBitsHex, toBitsHex, ulpDistance } from "../../src/bits"
import * as dmath from "../../src/dmath/index"

function lcg(seed: number): () => number {
  let s = seed >>> 0
  return () => {
    s = (Math.imul(s, 1103515245) + 12345) >>> 0
    return s / 4294967296
  }
}

interface Case {
  readonly name: string
  readonly ours: (x: number) => number
  readonly theirs: (x: number) => number
  readonly lo: number
  readonly hi: number
  readonly maxUlp: bigint
}

const CASES: readonly Case[] = [
  {
    name: "sin",
    ours: dmath.sin,
    theirs: Math.sin,
    lo: -1000,
    hi: 1000,
    maxUlp: 2n,
  },
  {
    name: "cos",
    ours: dmath.cos,
    theirs: Math.cos,
    lo: -1000,
    hi: 1000,
    maxUlp: 2n,
  },
  {
    name: "tan",
    ours: dmath.tan,
    theirs: Math.tan,
    lo: -1000,
    hi: 1000,
    maxUlp: 2n,
  },
  {
    name: "sin.large",
    ours: dmath.sin,
    theirs: Math.sin,
    lo: -1e9,
    hi: 1e9,
    maxUlp: 2n,
  },
  {
    name: "cos.large",
    ours: dmath.cos,
    theirs: Math.cos,
    lo: -1e9,
    hi: 1e9,
    maxUlp: 2n,
  },
  {
    name: "asin",
    ours: dmath.asin,
    theirs: Math.asin,
    lo: -1,
    hi: 1,
    maxUlp: 2n,
  },
  {
    name: "acos",
    ours: dmath.acos,
    theirs: Math.acos,
    lo: -1,
    hi: 1,
    maxUlp: 2n,
  },
  {
    name: "atan",
    ours: dmath.atan,
    theirs: Math.atan,
    lo: -1e6,
    hi: 1e6,
    maxUlp: 2n,
  },
  {
    name: "exp",
    ours: dmath.exp,
    theirs: Math.exp,
    lo: -700,
    hi: 700,
    maxUlp: 2n,
  },
  {
    name: "log",
    ours: dmath.log,
    theirs: Math.log,
    lo: 1e-30,
    hi: 1e30,
    maxUlp: 2n,
  },
  {
    name: "log2",
    ours: dmath.log2,
    theirs: Math.log2,
    lo: 1e-30,
    hi: 1e30,
    maxUlp: 4n,
  },
  {
    name: "log10",
    ours: dmath.log10,
    theirs: Math.log10,
    lo: 1e-30,
    hi: 1e30,
    maxUlp: 4n,
  },
]

describe("dmath against the host Math", () => {
  for (const c of CASES) {
    test(`${c.name} stays within ${c.maxUlp} ulp`, () => {
      const random = lcg(0x1234567)
      let worst = 0n
      let worstAt = 0
      for (let i = 0; i < 50_000; i++) {
        const x = c.lo + (c.hi - c.lo) * random()
        const d = ulpDistance(c.ours(x), c.theirs(x))
        if (d > worst) {
          worst = d
          worstAt = x
        }
      }
      expect(
        worst <= c.maxUlp,
        `${c.name}: worst ${worst} ulp at ${worstAt} (${toBitsHex(c.ours(worstAt))} vs ${toBitsHex(c.theirs(worstAt))})`,
      ).toBe(true)
    })
  }

  test("pow stays within 8 ulp of the host", () => {
    const random = lcg(0x7654321)
    let worst = 0n
    for (let i = 0; i < 50_000; i++) {
      const x = random() * 100
      const y = (random() - 0.5) * 20
      const d = ulpDistance(dmath.pow(x, y), x ** y)
      if (d > worst) worst = d
    }
    expect(worst <= 8n, `worst ${worst} ulp`).toBe(true)
  })

  test("atan2 stays within 2 ulp of the host", () => {
    const random = lcg(0xabcdef)
    let worst = 0n
    for (let i = 0; i < 50_000; i++) {
      const y = (random() - 0.5) * 2000
      const x = (random() - 0.5) * 2000
      const d = ulpDistance(dmath.atan2(y, x), Math.atan2(y, x))
      if (d > worst) worst = d
    }
    expect(worst <= 2n, `worst ${worst} ulp`).toBe(true)
  })
})

describe("dmath special cases match ECMAScript exactly", () => {
  // These are the cases the standard *does* specify, so there is no latitude
  // and no ulp bound: the bits have to match.
  //
  // Two things are canonicalised before comparing. A NaN's sign and payload
  // are not specified, so `log(-1)` legitimately returns a negative NaN here
  // and a positive one on the host; only "is it NaN" is meaningful. And the
  // exception file carries inputs where fdlibm itself differs from a host
  // library, which is a fact about the reference rather than a defect.

  const exceptions = JSON.parse(
    readFileSync(
      join(import.meta.dir, "vectors/oracle-exceptions.json"),
      "utf8",
    ),
  ) as Record<
    string,
    Array<{ argBits: string; oursBits: string; hostBits: string }>
  >

  /** Compares bits, with every NaN treated as one value. */
  function sameNumber(a: number, b: number): boolean {
    if (Number.isNaN(a) && Number.isNaN(b)) return true
    return toBitsHex(a) === toBitsHex(b)
  }

  function isKnownException(name: string, x: number): boolean {
    const rows = exceptions[name]
    if (rows === undefined) return false
    return rows.some((row) => row.argBits === toBitsHex(x))
  }

  /**
   * Only the inputs ECMAScript pins down. `log(3)` is not one of them: the
   * standard leaves it to the implementation, and JavaScriptCore's answer is
   * one step from fdlibm's. Asserting bit equality there would be asserting
   * that the host agrees with us, which is not a property anyone promised.
   */
  const ZEROS_AND_EDGES = [
    0,
    -0,
    Number.POSITIVE_INFINITY,
    Number.NEGATIVE_INFINITY,
    Number.NaN,
  ]

  test.each([
    ["sin", dmath.sin, Math.sin, ZEROS_AND_EDGES],
    ["cos", dmath.cos, Math.cos, ZEROS_AND_EDGES],
    ["tan", dmath.tan, Math.tan, ZEROS_AND_EDGES],
    ["asin", dmath.asin, Math.asin, [...ZEROS_AND_EDGES, 2, -2, 1.0000001]],
    ["acos", dmath.acos, Math.acos, [...ZEROS_AND_EDGES, 2, -2, 1.0000001]],
    ["atan", dmath.atan, Math.atan, ZEROS_AND_EDGES],
    ["exp", dmath.exp, Math.exp, ZEROS_AND_EDGES],
    ["log", dmath.log, Math.log, [...ZEROS_AND_EDGES, 1, -1, -2]],
  ] as const)("%s", (name, ours, theirs, inputs) => {
    for (const x of inputs) {
      if (isKnownException(name, x)) continue
      expect(
        sameNumber(ours(x), theirs(x)),
        `${name}(${x}): ${toBitsHex(ours(x))} vs ${toBitsHex(theirs(x))}`,
      ).toBe(true)
    }
  })

  test("every recorded exception is still exactly what it says", () => {
    // If a host library changes underneath us, this fails rather than the
    // check above passing for a different reason than the one written down.
    const hosts: Record<string, (x: number) => number> = { exp: Math.exp }
    const ours: Record<string, (x: number) => number> = { exp: dmath.exp }
    for (const [name, rows] of Object.entries(exceptions)) {
      if (name.startsWith("_")) continue
      for (const row of rows) {
        const x = fromBitsHex(row.argBits)
        expect(
          toBitsHex((ours[name] as (v: number) => number)(x)),
          `${name} ours`,
        ).toBe(row.oursBits)
        expect(
          toBitsHex((hosts[name] as (v: number) => number)(x)),
          `${name} host`,
        ).toBe(row.hostBits)
      }
    }
  })

  test("atan2 over the whole sign table", () => {
    const values = [
      0,
      -0,
      1,
      -1,
      Number.POSITIVE_INFINITY,
      Number.NEGATIVE_INFINITY,
      Number.NaN,
    ]
    for (const y of values) {
      for (const x of values) {
        expect(
          sameNumber(dmath.atan2(y, x), Math.atan2(y, x)),
          `atan2(${y}, ${x})`,
        ).toBe(true)
      }
    }
  })

  test("pow over the whole special-case table", () => {
    const bases = [
      0,
      -0,
      1,
      -1,
      2,
      -2,
      0.5,
      Number.POSITIVE_INFINITY,
      Number.NEGATIVE_INFINITY,
      Number.NaN,
    ]
    const exponents = [
      0,
      -0,
      1,
      -1,
      2,
      -2,
      3,
      -3,
      0.5,
      -0.5,
      Number.POSITIVE_INFINITY,
      Number.NEGATIVE_INFINITY,
      Number.NaN,
    ]
    for (const b of bases) {
      for (const e of exponents) {
        expect(sameNumber(dmath.pow(b, e), b ** e), `pow(${b}, ${e})`).toBe(
          true,
        )
      }
    }
  })

  test("hypot over the whole special-case table", () => {
    // Only the values ECMAScript pins down. hypot(3, 3) is 3*sqrt(2), which
    // this scaled form rounds one step from the host's, and that is stated in
    // the module rather than hidden here.
    const values = [
      0,
      -0,
      1,
      -1,
      Number.POSITIVE_INFINITY,
      Number.NEGATIVE_INFINITY,
      Number.NaN,
    ]
    for (const a of values) {
      for (const b of values) {
        expect(
          sameNumber(dmath.hypot(a, b), Math.hypot(a, b)),
          `hypot(${a}, ${b})`,
        ).toBe(true)
      }
    }
  })

  test("hypot stays within 2 ulp of the host elsewhere", () => {
    const random = lcg(0x2468ace)
    let worst = 0n
    for (let i = 0; i < 50_000; i++) {
      const a = (random() - 0.5) * 2e6
      const b = (random() - 0.5) * 2e6
      const d = ulpDistance(dmath.hypot(a, b), Math.hypot(a, b))
      if (d > worst) worst = d
    }
    expect(worst <= 2n, `worst ${worst} ulp`).toBe(true)
  })
})
