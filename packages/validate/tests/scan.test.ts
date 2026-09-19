import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { scanImportGraph } from "../src/scan/import-graph"

const FIXTURES = join(import.meta.dir, "../fixtures")

function scan(fixture: string) {
  return scanImportGraph(join(FIXTURES, fixture, "index.ts"))
}

describe("the import-graph scan", () => {
  test("a conforming game names nothing banned", () => {
    const result = scan("conforming")
    expect(result.findings).toEqual([])
    expect(result.unresolved).toEqual([])
  })

  test("the kernel is trusted rather than scanned", () => {
    // The kernel names Date and performance in its own trap table, so
    // scanning it would report the mechanism as a violation.
    const result = scan("conforming")
    expect(result.trusted).toContain("@clockwork2/kernel")
    expect(result.files.every((f) => !f.includes("packages/kernel/src"))).toBe(
      true,
    )
  })

  test("it follows a relative import", () => {
    // Every fixture imports ../manifest, which has to be read too.
    const result = scan("unbounded")
    expect(result.files.length).toBe(2)
    expect(result.files.some((f) => f.endsWith("fixtures/manifest.ts"))).toBe(
      true,
    )
  })

  test("it names what it found, where", () => {
    const found = scan("banned-clock").findings
    const names = found.map((f) => f.name)
    expect(names).toContain("Date.now")
    expect(names).toContain("performance.now")
    expect(names).toContain("setTimeout")
    for (const finding of found) {
      expect(finding.line).toBeGreaterThan(0)
      expect(finding.column).toBeGreaterThan(0)
      expect(finding.file).toContain("banned-clock")
      expect(finding.why.length).toBeGreaterThan(0)
    }
  })

  test("a banned member is reported once, not twice", () => {
    // `Date.now` is the member and `Date` is the global; reporting both would
    // put two findings on one character position.
    const found = scan("banned-clock").findings
    const positions = found.map((f) => `${f.line}:${f.column}`)
    expect(new Set(positions).size).toBe(positions.length)
  })

  test("the exponent operator and Math.pow are both caught", () => {
    const names = scan("banned-pow").findings.map((f) => f.name)
    expect(names).toContain("Math.pow")
    expect(names).toContain("**")
  })

  test("async and await are caught as their own kind", () => {
    const found = scan("async-tick").findings.filter((f) => f.kind === "async")
    expect(found.map((f) => f.name).sort()).toEqual(["async", "await"])
  })

  test("Math.sqrt and the rounding family are allowed", () => {
    // These are exactly specified, so a simulation may call them directly.
    const result = scanImportGraph(join(FIXTURES, "conforming/index.ts"))
    expect(result.findings.filter((f) => f.name.startsWith("Math."))).toEqual(
      [],
    )
  })

  test("line and column point into the source a developer has", () => {
    // The scan reads TypeScript directly rather than transpiling first,
    // because a transpiled form has moved every line.
    const found = scan("banned-math").findings
    const random = found.find((f) => f.name === "Math.random")
    expect(random).toBeDefined()
    const source = readFileSync((random as { file: string }).file, "utf8")
    const line = source.split("\n")[
      (random as { line: number }).line - 1
    ] as string
    expect(line).toContain("Math.random")
  })
})
