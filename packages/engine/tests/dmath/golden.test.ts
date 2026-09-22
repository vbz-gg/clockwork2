import { describe, expect, test } from "bun:test"
import { createHash } from "node:crypto"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { fromBitsHex, toBitsHex, ulpDistance } from "../../src/bits"
import * as dmath from "../../src/dmath/index"

const VECTORS = join(import.meta.dir, "vectors/dmath-golden.tsv")
const CHECKSUM = join(import.meta.dir, "vectors/dmath-golden.sha256")

type Unary = (x: number) => number
type Binary = (a: number, b: number) => number

const UNARY: Record<string, Unary> = {
  sin: dmath.sin,
  cos: dmath.cos,
  tan: dmath.tan,
  asin: dmath.asin,
  acos: dmath.acos,
  atan: dmath.atan,
  exp: dmath.exp,
  log: dmath.log,
  log2: dmath.log2,
  log10: dmath.log10,
  wrapAngle: dmath.wrapAngle,
}

const BINARY: Record<string, Binary> = {
  atan2: dmath.atan2,
  hypot: dmath.hypot,
  pow: dmath.pow,
  ipow: dmath.ipow,
}

/**
 * Whether a result matches the vector.
 *
 * Exact bits, except for a NaN. ECMAScript leaves a NaN's sign and payload to
 * the implementation, and the hardware disagrees: an invalid operation yields
 * the negative quiet NaN 0xFFF8000000000000 on x86 and the positive one
 * 0x7FF8000000000000 on arm64. Every dmath routine that can generate a NaN
 * therefore returns a different bit pattern on an Apple Silicon Mac than on a
 * Linux x64 runner - 1074 of these vectors, measured - while propagating a NaN
 * that arrived as an argument keeps its sign on both.
 *
 * Pinning the sign here would be pinning the architecture. Nothing downstream
 * can see it: `hashCanonical` refuses NaN outright rather than encoding it,
 * counters must be whole numbers, and a recording is JSON, where a NaN does
 * not survive `JSON.stringify` at all. So a vector whose result is a NaN says
 * that the result is a NaN, and nothing about which one.
 */
function matches(actualBits: string, expectedBits: string): boolean {
  if (actualBits === expectedBits) return true
  return (
    Number.isNaN(fromBitsHex(actualBits)) &&
    Number.isNaN(fromBitsHex(expectedBits))
  )
}

describe("dmath golden vectors", () => {
  const raw = readFileSync(VECTORS, "utf8")
  const rows = raw
    .split("\n")
    .filter((line) => line.length > 0 && !line.startsWith("#"))

  test("the vector file is the one that was reviewed", () => {
    // A truncated or line-ending-mangled checkout would otherwise pass with
    // fewer cases and nobody would notice.
    const actual = createHash("sha256").update(raw).digest("hex")
    const expected = readFileSync(CHECKSUM, "utf8").trim().split(/\s+/)[0]
    expect(actual).toBe(expected as string)
  })

  test("every vector still holds", () => {
    expect(rows.length).toBeGreaterThan(9000)
    let checked = 0
    for (let i = 0; i < rows.length; i++) {
      const parts = (rows[i] as string).split("\t")
      const name = parts[0] as string
      const unary = UNARY[name]
      if (unary !== undefined) {
        const x = fromBitsHex(parts[1] as string)
        const actual = toBitsHex(unary(x))
        if (!matches(actual, parts[2] as string)) {
          throw new Error(
            `line ${i + 3}: ${name}(${x}) is ${actual}, the vector says ${parts[2]}`,
          )
        }
        checked++
        continue
      }
      const binary = BINARY[name]
      if (binary === undefined) throw new Error(`unknown routine ${name}`)
      const a = fromBitsHex(parts[1] as string)
      const b = fromBitsHex(parts[2] as string)
      const actual = toBitsHex(binary(a, b))
      if (!matches(actual, parts[3] as string)) {
        throw new Error(
          `line ${i + 3}: ${name}(${a}, ${b}) is ${actual}, the vector says ${parts[3]}`,
        )
      }
      checked++
    }
    expect(checked).toBe(rows.length)
  })

  test("the vectors cover every exported routine", () => {
    const covered = new Set(rows.map((line) => line.split("\t")[0]))
    for (const name of [...Object.keys(UNARY), ...Object.keys(BINARY)]) {
      expect(covered.has(name)).toBe(true)
    }
  })

  test("the vectors include the hard cases, not just easy ones", () => {
    const sinRows = rows.filter((line) => line.startsWith("sin\t"))
    const args = sinRows.map((line) =>
      fromBitsHex(line.split("\t")[1] as string),
    )
    // Past the Cody-Waite range, so Payne-Hanek is exercised.
    expect(args.some((x) => Math.abs(x) > 1e6)).toBe(true)
    // Exactly on a quarter turn, where reduction cancels hardest.
    expect(args.some((x) => x === 32 * dmath.PI_2)).toBe(true)
    expect(args.some((x) => Number.isNaN(x))).toBe(true)
    expect(args.some((x) => Object.is(x, -0))).toBe(true)
    expect(args.some((x) => x === Number.MIN_VALUE)).toBe(true)
  })
})

describe("dmath equals itself", () => {
  test("a second call on the same input gives the same bits", () => {
    // Guards against a routine leaking state through its shared scratch array.
    for (const [name, fn] of Object.entries(UNARY)) {
      for (const x of [0.1, 1e6, 1e30, -7.25, 0.5]) {
        expect(ulpDistance(fn(x), fn(x)), `${name}(${x})`).toBe(0n)
      }
    }
  })

  test("interleaved calls do not disturb each other", () => {
    // sin, cos and tan share one reduction scratch pair.
    const a = dmath.sin(123456.789)
    const between = dmath.cos(1e9)
    const b = dmath.sin(123456.789)
    expect(toBitsHex(a)).toBe(toBitsHex(b))
    expect(Number.isFinite(between)).toBe(true)
  })
})
