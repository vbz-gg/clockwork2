/**
 * An engine error is recognised by any copy of the engine.
 *
 * A studio's page holds two copies: the one the page module bundles and the
 * one inside the rules code it imports, and the conformance checker loads a
 * third inside the built rules code. An error the rules code's copy throws is
 * caught by the page module's, where `instanceof` compares two different
 * classes and says no, and a refusal would read as an unknown crash.
 */

import { describe, expect, test } from "bun:test"
import { ClockworkError, fail, isClockworkError } from "../../src/errors"

/**
 * A second copy of the module: a different class, a different `fail`. Bun
 * loads a specifier with a query string as a module of its own, and the
 * specifier is a variable because the type checker cannot resolve one.
 */
async function secondCopy(): Promise<typeof import("../../src/errors")> {
  const specifier = "../../src/errors.ts?second-copy"
  return (await import(specifier)) as typeof import("../../src/errors")
}

const thrown = (run: () => unknown): unknown => {
  try {
    run()
  } catch (error) {
    return error
  }
  throw new Error("nothing was thrown")
}

describe("isClockworkError", () => {
  test("knows an error thrown by another copy of the engine, and reads its code", async () => {
    const other = await secondCopy()
    expect(other.ClockworkError).not.toBe(ClockworkError)
    const error = thrown(() => other.fail("E_INPUT_UNDECLARED", { tick: 3 }))
    expect(error instanceof ClockworkError).toBe(false)
    expect(isClockworkError(error)).toBe(true)
    if (!isClockworkError(error)) throw new Error("unreachable")
    expect(error.code).toBe("E_INPUT_UNDECLARED")
    expect(error.tag).toBe("E_INPUT_UNDECLARED@3")
  })

  test("knows its own copy's errors", () => {
    expect(isClockworkError(thrown(() => fail("E_INPUT_BUDGET")))).toBe(true)
  })

  test("refuses anything that only looks like one", () => {
    expect(isClockworkError(new Error("E_INPUT_BUDGET"))).toBe(false)
    expect(isClockworkError({ code: "E_INPUT_BUDGET" })).toBe(false)
    expect(isClockworkError(null)).toBe(false)
    expect(isClockworkError("E_INPUT_BUDGET")).toBe(false)
    // Marked, but with a code the engine does not have.
    const forged = Object.defineProperty(
      { code: "E_NOT_A_CODE" },
      Symbol.for("clockwork2.error"),
      { value: true },
    )
    expect(isClockworkError(forged)).toBe(false)
  })
})
