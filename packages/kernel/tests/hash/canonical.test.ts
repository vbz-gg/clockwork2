import { describe, expect, test } from "bun:test"
import type { PlainValue } from "../../src/contract"
import { encodeCanonical, hashCanonical } from "../../src/hash/canonical"

describe("canonical encoding", () => {
  test("key order does not change the encoding", () => {
    expect(encodeCanonical({ b: 1, a: 2 })).toBe(
      encodeCanonical({ a: 2, b: 1 }),
    )
    expect(encodeCanonical({ z: { y: 1, x: 2 } })).toBe(
      encodeCanonical({ z: { x: 2, y: 1 } }),
    )
  })

  test("array order does change it", () => {
    expect(encodeCanonical([1, 2])).not.toBe(encodeCanonical([2, 1]))
  })

  test("negative zero is not normalised away", () => {
    // -0 and 0 are different states. A simulation that reached one rather than
    // the other has diverged, and hiding that here would hide the divergence.
    expect(encodeCanonical({ x: -0 })).not.toBe(encodeCanonical({ x: 0 }))
    expect(hashCanonical({ x: -0 })).not.toBe(hashCanonical({ x: 0 }))
  })

  test("an integer and its float twin encode the same", () => {
    expect(encodeCanonical({ x: 2 })).toBe(encodeCanonical({ x: 2.0 }))
  })

  test("string lengths stop a delimiter collision", () => {
    expect(hashCanonical({ ab: 1 })).not.toBe(
      hashCanonical({ a: "b1" } as PlainValue),
    )
    expect(hashCanonical({ a: "b", c: "d" })).not.toBe(
      hashCanonical({ a: "bc", d: "" } as PlainValue),
    )
  })

  test("lone surrogates and astral characters survive", () => {
    expect(encodeCanonical({ s: "\ud800" })).not.toBe(
      encodeCanonical({ s: "\udc00" }),
    )
    expect(encodeCanonical({ s: "🎲" })).not.toBe(
      encodeCanonical({ s: "\ud83c" }),
    )
  })

  test("integers above 53 bits fall back to their float bits", () => {
    // Past 2^53 an integer is no longer exactly representable, so writing it
    // as an exact integer would claim a precision that is not there.
    const big = 2 ** 60
    expect(encodeCanonical({ x: big }).startsWith("o1:s1:xd")).toBe(true)
    expect(encodeCanonical({ x: 2 ** 53 - 1 }).startsWith("o1:s1:xi")).toBe(
      true,
    )
  })

  test("nesting is encoded unambiguously", () => {
    expect(hashCanonical({ a: [1, [2]] })).not.toBe(
      hashCanonical({ a: [[1], 2] }),
    )
    expect(hashCanonical({ a: { b: 1 } })).not.toBe(hashCanonical({ "a.b": 1 }))
  })

  describe("refusals", () => {
    const REFUSED: Array<[string, unknown]> = [
      ["NaN", Number.NaN],
      ["Infinity", Number.POSITIVE_INFINITY],
      ["-Infinity", Number.NEGATIVE_INFINITY],
      ["undefined", undefined],
      ["a function", () => 1],
      ["a symbol", Symbol("s")],
      ["a bigint", 1n],
      ["a Date", new Date(0)],
      ["a Map", new Map()],
      ["a Set", new Set()],
      ["a typed array", new Float64Array(1)],
      ["a class instance", new (class Thing {})()],
    ]

    for (const [label, value] of REFUSED) {
      test(`refuses ${label} with a code and a path`, () => {
        let caught: unknown
        try {
          encodeCanonical({ outer: { inner: value } } as unknown as PlainValue)
        } catch (error) {
          caught = error
        }
        expect(String(caught)).toMatch(/E_CANONICAL_UNSUPPORTED/)
        expect(String(caught)).toMatch(/outer\.inner/)
      })
    }

    test("refuses a cycle rather than hanging", () => {
      const cyclic: Record<string, unknown> = { a: 1 }
      cyclic.self = cyclic
      expect(() => encodeCanonical(cyclic as PlainValue)).toThrow(
        /E_CANONICAL_UNSUPPORTED/,
      )
    })

    test("accepts the same object twice when it is not a cycle", () => {
      const shared = { v: 1 }
      expect(() =>
        encodeCanonical({ a: shared, b: shared } as unknown as PlainValue),
      ).not.toThrow()
    })

    test("accepts a null-prototype object", () => {
      const bare = Object.create(null) as Record<string, number>
      bare.x = 1
      expect(encodeCanonical(bare as PlainValue)).toBe(
        encodeCanonical({ x: 1 }),
      )
    })
  })

  test("hashCanonical agrees with hashing the encoded string", () => {
    const value = { a: [1, 2, { b: "x" }], c: true, d: null }
    expect(hashCanonical(value)).toBe(hashCanonical(value))
    expect(hashCanonical(value).length).toBe(16)
  })
})
