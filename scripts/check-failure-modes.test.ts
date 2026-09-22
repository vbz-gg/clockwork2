import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { ERROR_CODES } from "../packages/engine/src/errors"
import {
  codesInReference,
  codesInSource,
  compare,
  ERRORS_SOURCE,
  REFERENCE,
} from "./check-failure-modes"

describe("the source parser", () => {
  test("reads exactly the codes the kernel exports", () => {
    // The guard is a pair of regexes over text. If one silently stops
    // matching it reports no drift and passes every commit from then on, so
    // this compares it against the table it is standing in for.
    expect(codesInSource(readFileSync(ERRORS_SOURCE, "utf8"))).toEqual(
      Object.keys(ERROR_CODES),
    )
  })

  test("a code named in a comment is not a declaration", () => {
    const source = [
      "export const ERROR_CODES = {",
      "  /** Unlike E_GHOST, this one is real. */",
      "  // E_ALSO_NOT_REAL: never declared",
      '  E_REAL: "a real one",',
      "} as const",
    ].join("\n")
    expect(codesInSource(source)).toEqual(["E_REAL"])
  })

  test("a declaration after the table is not a code", () => {
    const source = [
      "export const ERROR_CODES = {",
      '  E_REAL: "a real one",',
      "} as const",
      "",
      "const LOOKALIKE = {",
      '  E_OUTSIDE: "not part of the contract",',
      "}",
    ].join("\n")
    expect(codesInSource(source)).toEqual(["E_REAL"])
  })

  test("a table it cannot find yields nothing, rather than guessing", () => {
    expect(codesInSource("export const SOMETHING_ELSE = {}")).toEqual([])
  })
})

describe("the reference parser", () => {
  test("reads a section per heading", () => {
    const markdown = [
      "# Failure modes",
      "",
      "## Runtime",
      "",
      "### E_ASYNC_TICK",
      "",
      "Some prose mentioning E_BANNED_API in passing.",
      "",
      "### E_SEED_REQUIRED",
    ].join("\n")
    expect(codesInReference(markdown)).toEqual([
      "E_ASYNC_TICK",
      "E_SEED_REQUIRED",
    ])
  })

  test("a heading at another level is not a section", () => {
    expect(codesInReference("## E_ASYNC_TICK\n#### E_BANNED_API\n")).toEqual([])
  })
})

describe("the comparison", () => {
  test("a code with no section is reported", () => {
    const drift = compare(["E_A", "E_B"], ["E_A"])
    expect(drift.undocumented).toEqual(["E_B"])
    expect(drift.stale).toEqual([])
  })

  test("a section with no code is reported", () => {
    const drift = compare(["E_A"], ["E_A", "E_GONE"])
    expect(drift.stale).toEqual(["E_GONE"])
    expect(drift.undocumented).toEqual([])
  })

  test("a code explained twice is reported", () => {
    expect(compare(["E_A"], ["E_A", "E_A"]).duplicated).toEqual(["E_A"])
  })

  test("order is not drift", () => {
    const drift = compare(["E_A", "E_B"], ["E_B", "E_A"])
    expect(drift.undocumented).toEqual([])
    expect(drift.stale).toEqual([])
    expect(drift.duplicated).toEqual([])
  })
})

describe("the repository itself", () => {
  test("every code has a section and every section has a code", () => {
    const codes = codesInSource(readFileSync(ERRORS_SOURCE, "utf8"))
    const sections = codesInReference(readFileSync(REFERENCE, "utf8"))
    const drift = compare(codes, sections)
    expect(drift.undocumented).toEqual([])
    expect(drift.stale).toEqual([])
    expect(drift.duplicated).toEqual([])
    expect(codes.length).toBeGreaterThan(20)
  })
})
