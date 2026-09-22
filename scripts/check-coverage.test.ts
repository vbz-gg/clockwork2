/**
 * The coverage gate's own arithmetic.
 *
 * The gate is the one test in the suite whose failure message people act on
 * without reading the code behind it, so the number it reports has to be the
 * number they need. Two of these are about that rather than about parsing:
 * `linesShort` has to report enough lines, and the ratio has to survive an
 * empty report instead of dividing by zero.
 */

import { describe, expect, test } from "bun:test"
import {
  type FileCoverage,
  linesShort,
  MIN_FUNCTIONS,
  MIN_LINES,
  parseLcov,
  ratio,
  total,
  worstFiles,
} from "./check-coverage"

/** The shape bun 1.3.11 writes, including a record carrying no FN rows. */
const LCOV = `TN:
SF:packages/kernel/src/bits.ts
FNF:7
FNH:7
DA:1,25
DA:2,0
LF:90
LH:86
end_of_record
TN:
SF:packages/kernel/src/fixed.ts
FNF:12
FNH:12
DA:1,4
LF:40
LH:40
end_of_record
TN:
SF:packages/host-bridge/src/audio.ts
LF:68
LH:11
end_of_record
`

function file(over: Partial<FileCoverage>): FileCoverage {
  return {
    path: "packages/x/src/a.ts",
    linesFound: 10,
    linesHit: 10,
    functionsFound: 2,
    functionsHit: 2,
    ...over,
  }
}

describe("parseLcov", () => {
  test("reads one record per file, in the order lcov wrote them", () => {
    expect(parseLcov(LCOV).map((f) => f.path)).toEqual([
      "packages/kernel/src/bits.ts",
      "packages/kernel/src/fixed.ts",
      "packages/host-bridge/src/audio.ts",
    ])
  })

  test("reads the found and hit counts, not the per-line DA rows", () => {
    const [bits] = parseLcov(LCOV)
    expect(bits).toEqual({
      path: "packages/kernel/src/bits.ts",
      linesFound: 90,
      linesHit: 86,
      functionsFound: 7,
      functionsHit: 7,
    })
  })

  test("a record with no FN rows counts as no functions, not as a parse failure", () => {
    const audio = parseLcov(LCOV)[2] as FileCoverage
    expect(audio.functionsFound).toBe(0)
    expect(audio.linesFound).toBe(68)
  })

  test("CRLF line endings read the same as LF", () => {
    expect(parseLcov(LCOV.replace(/\n/g, "\r\n"))).toEqual(parseLcov(LCOV))
  })

  test("text with no SF record yields nothing, so the gate can say so", () => {
    expect(parseLcov("")).toEqual([])
    expect(parseLcov("TN:\nend_of_record\n")).toEqual([])
  })
})

describe("total", () => {
  test("sums every record", () => {
    expect(total(parseLcov(LCOV))).toEqual({
      linesFound: 198,
      linesHit: 137,
      functionsFound: 19,
      functionsHit: 19,
    })
  })

  test("an empty report totals to zero rather than throwing", () => {
    expect(total([])).toEqual({
      linesFound: 0,
      linesHit: 0,
      functionsFound: 0,
      functionsHit: 0,
    })
  })
})

describe("ratio", () => {
  test("nothing found reads as covered, so an empty report cannot divide by zero", () => {
    expect(ratio(0, 0)).toBe(1)
  })

  test("otherwise it is hit over found", () => {
    expect(ratio(137, 198)).toBeCloseTo(0.6919, 4)
  })
})

describe("linesShort", () => {
  test("zero once the floor is met", () => {
    expect(linesShort({ ...total([]), linesFound: 100, linesHit: 99 })).toBe(0)
  })

  /**
   * The number it prints is the number someone will go and cover. If it is one
   * short they do the work, run the gate again and it still fails, which is
   * worse than no number at all. So: covering exactly this many more lines has
   * to reach the floor, at every denominator, and one fewer must not.
   */
  test("covering the reported shortfall always reaches the floor", () => {
    for (let found = 1; found <= 600; found++) {
      for (const hit of [0, Math.floor(found / 2), found - 1, found]) {
        const totals = { ...total([]), linesFound: found, linesHit: hit }
        const short = linesShort(totals)
        expect((hit + short) / found).toBeGreaterThanOrEqual(MIN_LINES)
        if (short > 0) {
          expect((hit + short - 1) / found).toBeLessThan(MIN_LINES)
        }
      }
    }
  })
})

describe("worstFiles", () => {
  test("ranks by uncovered lines, not by percentage", () => {
    const files = [
      file({ path: "small-but-bad.ts", linesFound: 10, linesHit: 1 }),
      file({ path: "big-and-middling.ts", linesFound: 400, linesHit: 300 }),
    ]
    expect(worstFiles(files, 2).map((f) => f.path)).toEqual([
      "big-and-middling.ts",
      "small-but-bad.ts",
    ])
  })

  test("leaves out files with nothing uncovered", () => {
    const files = [
      file({ path: "done.ts" }),
      file({ path: "short.ts", linesFound: 10, linesHit: 9 }),
    ]
    expect(worstFiles(files, 10).map((f) => f.path)).toEqual(["short.ts"])
  })

  test("breaks a tie by path, so two runs print the same order", () => {
    const files = [
      file({ path: "b.ts", linesFound: 10, linesHit: 5 }),
      file({ path: "a.ts", linesFound: 10, linesHit: 5 }),
    ]
    expect(worstFiles(files, 10).map((f) => f.path)).toEqual(["a.ts", "b.ts"])
  })

  test("returns at most the count asked for", () => {
    const files = [1, 2, 3, 4].map((n) =>
      file({ path: `${n}.ts`, linesFound: 10, linesHit: 0 }),
    )
    expect(worstFiles(files, 2)).toHaveLength(2)
  })
})

describe("the floors themselves", () => {
  test("lines is the 99% the project promises", () => {
    expect(MIN_LINES).toBe(0.99)
  })

  /**
   * Not a restatement: the point is that the function floor is allowed to sit
   * below the line floor and must never sit above it, because bun counts
   * getters and inline arrows as functions and a file can be fully covered by
   * line while leaving one getter uncalled.
   */
  test("functions is a floor below lines, and both are fractions", () => {
    expect(MIN_FUNCTIONS).toBeLessThanOrEqual(MIN_LINES)
    expect(MIN_FUNCTIONS).toBeGreaterThan(0)
    expect(MIN_LINES).toBeLessThanOrEqual(1)
  })
})
