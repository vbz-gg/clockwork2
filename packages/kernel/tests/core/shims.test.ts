import { describe, expect, test } from "bun:test"
import { shimsInstalled, unshimmableApis, withShims } from "../../src/shims"

/**
 * Each row is a way a game would actually reach a banned API, and the name the
 * trap is expected to report.
 *
 * The reported name is the global itself rather than the member, because the
 * trap is a getter on the binding: reading `Date` at all fails, which is the
 * point. `typeof Date` inside a simulation is already a sign that something is
 * about to go wrong.
 *
 * The conformance suite's failure-modes reference is written against these, so
 * a trap that stops firing breaks a test rather than quietly widening what a
 * game may do.
 */
const FORBIDDEN: Array<
  [label: string, reported: string, reach: () => unknown]
> = [
  ["Math.random", "Math.random", () => Math.random()],
  ["Math.pow", "Math.pow", () => Math.pow(2, 3)],
  ["Date.now", "Date", () => Date.now()],
  ["new Date", "Date", () => new Date()],
  ["performance.now", "performance", () => performance.now()],
  ["setTimeout", "setTimeout", () => setTimeout(() => undefined, 0)],
  ["setInterval", "setInterval", () => setInterval(() => undefined, 1000)],
  ["queueMicrotask", "queueMicrotask", () => queueMicrotask(() => undefined)],
  ["crypto", "crypto", () => crypto.getRandomValues(new Uint8Array(1))],
  ["Intl", "Intl", () => new Intl.NumberFormat()],
  ["toLocaleString", "toLocaleString", () => (1234.5).toLocaleString()],
  ["localeCompare", "localeCompare", () => "a".localeCompare("b")],
  ["WeakRef", "WeakRef", () => new WeakRef({})],
  [
    "FinalizationRegistry",
    "FinalizationRegistry",
    () => new FinalizationRegistry(() => undefined),
  ],
  ["structuredClone", "structuredClone", () => structuredClone({ a: 1 })],
  ["fetch", "fetch", () => fetch("https://example.invalid")],
]

describe("runtime shims", () => {
  test.each(FORBIDDEN)(
    "%s throws E_BANNED_API inside a simulation",
    (label, reported, reach) => {
      withShims(() => {
        let caught: unknown
        try {
          reach()
        } catch (error) {
          caught = error
        }
        expect(String(caught), label).toMatch(/E_BANNED_API/)
        expect(String(caught), label).toContain(reported)
      })
    },
  )

  test("everything allowed still works while the traps are up", () => {
    withShims(() => {
      expect(Math.sqrt(2)).toBe(Math.SQRT2)
      expect(Math.floor(1.5)).toBe(1)
      expect(Math.imul(3, 4)).toBe(12)
      expect(Math.fround(0.1)).toBe(0.10000000149011612)
      expect(Math.clz32(1)).toBe(31)
      expect(new Float64Array(1).length).toBe(1)
      expect(JSON.parse(JSON.stringify({ a: 1 }))).toEqual({ a: 1 })
    })
  })

  test("the globals come back afterwards", () => {
    withShims(() => undefined)
    expect(typeof Math.random()).toBe("number")
    expect(typeof Date.now()).toBe("number")
    expect(typeof performance.now()).toBe("number")
    expect(Math.pow(2, 3)).toBe(8)
  })

  test("they come back even when the body throws", () => {
    expect(() =>
      withShims(() => {
        throw new Error("boom")
      }),
    ).toThrow("boom")
    expect(typeof Math.random()).toBe("number")
  })

  test("nesting is counted, so an inner call cannot take the traps down", () => {
    withShims(() => {
      withShims(() => {
        expect(shimsInstalled()).toBe(true)
      })
      expect(shimsInstalled()).toBe(true)
      expect(() => Math.random()).toThrow(/E_BANNED_API/)
    })
    expect(shimsInstalled()).toBe(false)
  })

  test("anything that could not be trapped is reported rather than hidden", () => {
    // On this runtime the list should be empty. If it ever is not, the static
    // scan in @clockwork2/validate is what covers those names, and the list is
    // how anyone finds out which.
    withShims(() => {
      expect(Array.isArray(unshimmableApis())).toBe(true)
    })
  })
})
