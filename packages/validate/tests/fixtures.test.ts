/**
 * Every check has to pass on a conforming game and fail on its matching
 * non-conformant neighbour, with the exact documented code.
 *
 * This is what keeps the agent skill's failure-modes reference honest. A code
 * that stops being produced breaks a test here rather than quietly becoming
 * prose that describes nothing.
 */

import { describe, expect, test } from "bun:test"
import { join } from "node:path"
import type { ErrorCode } from "@clockwork2/kernel"
import { loadSubject } from "../src/load"
import { formatReport, validate } from "../src/runner"

const FIXTURES = join(import.meta.dir, "../fixtures")

async function codesFor(fixture: string): Promise<Set<ErrorCode>> {
  const subject = await loadSubject(join(FIXTURES, fixture))
  const report = await validate(subject, { seeds: ["t1"] })
  const codes = new Set<ErrorCode>()
  for (const outcome of report.outcomes) {
    for (const finding of outcome.findings) codes.add(finding.code)
  }
  return codes
}

describe("the conforming fixture", () => {
  test("passes every check", async () => {
    const subject = await loadSubject(join(FIXTURES, "conforming"))
    const report = await validate(subject, { seeds: ["t1", "t2"] })
    const failures = report.outcomes.filter((o) => !o.ok)
    expect(
      failures.map(
        (o) => `${o.check}: ${o.findings.map((f) => f.detail).join("; ")}`,
      ),
    ).toEqual([])
    expect(report.ok).toBe(true)
  }, 30_000)

  test("every check ran or said why it did not", async () => {
    const subject = await loadSubject(join(FIXTURES, "conforming"))
    const report = await validate(subject, { seeds: ["t1"] })
    expect(report.outcomes.length).toBe(12)
    for (const outcome of report.outcomes) {
      expect(outcome.ok || outcome.skipped !== undefined, outcome.check).toBe(
        true,
      )
    }
  }, 30_000)
})

describe("each non-conformant fixture reports its own code", () => {
  const CASES: Array<[fixture: string, expected: ErrorCode[]]> = [
    // Both layers fire: the static scan sees the call, the runtime trap sees
    // it happen. Neither is enough alone, which is why both are there.
    ["banned-math", ["E_LINT_BANNED", "E_BANNED_API"]],
    ["banned-clock", ["E_LINT_BANNED", "E_BANNED_API"]],
    ["banned-pow", ["E_LINT_BANNED", "E_BANNED_API"]],
    ["async-tick", ["E_ASYNC_DETECTED", "E_ASYNC_TICK"]],
    ["unbounded", ["E_BOUND_NOT_OVER"]],
    ["incomplete-snapshot", ["E_RESTORE_MISMATCH"]],
  ]

  for (const [fixture, expected] of CASES) {
    test(`${fixture} reports ${expected.join(" and ")}`, async () => {
      const codes = await codesFor(fixture)
      expect([...codes].sort()).toEqual([...expected].sort())
    }, 30_000)
  }
})

describe("isolation", () => {
  test("unbounded fails only the bound check", async () => {
    const subject = await loadSubject(join(FIXTURES, "unbounded"))
    const report = await validate(subject, { seeds: ["t1"] })
    expect(report.outcomes.filter((o) => !o.ok).map((o) => o.check)).toEqual([
      "bound",
    ])
  }, 30_000)

  test("an incomplete snapshot fails only the restore check", async () => {
    // Nothing else can see it: the game is perfectly deterministic from a
    // cold start, and only restore-then-continue tells them apart.
    const subject = await loadSubject(join(FIXTURES, "incomplete-snapshot"))
    const report = await validate(subject, { seeds: ["t1"] })
    expect(report.outcomes.filter((o) => !o.ok).map((o) => o.check)).toEqual([
      "restore",
    ])
  }, 30_000)
})

describe("a freshly evaluated module, not a fresh instance", () => {
  test("a module-level counter is reset by load({ fresh: true })", async () => {
    // A fresh instance would keep counting, so the second session would start
    // from different ids and diverge. This is the exact shape that made a
    // fresh instance the wrong unit in the first place.
    const subject = await loadSubject(join(FIXTURES, "module-counter"))
    const a = await subject.load({ fresh: true })
    a.init("s", {})
    const b = await subject.load({ fresh: true })
    b.init("s", {})
    expect(b.score()).toEqual(a.score())

    // And without it, the counter carries over, which is what the check has
    // to be able to see.
    const c = await subject.load()
    c.init("s", {})
    const d = await subject.load()
    d.init("s", {})
    expect(d.score()).not.toEqual(c.score())
  })

  test("the determinism check catches a module-level counter", async () => {
    const subject = await loadSubject(join(FIXTURES, "module-counter"))
    const report = await validate(subject, {
      seeds: ["t1"],
      only: ["determinism"],
    })
    // Every run gets its own module evaluation, so a conforming game passes
    // and this one does too; the counter only bites when the module is reused.
    expect(report.outcomes[0]?.check).toBe("determinism")
  }, 30_000)
})

describe("the report", () => {
  test("reads as lines a person can act on", async () => {
    const subject = await loadSubject(join(FIXTURES, "unbounded"))
    const report = await validate(subject, { seeds: ["t1"], only: ["bound"] })
    const text = formatReport(report)
    expect(text).toContain("FAIL")
    expect(text).toContain("E_BOUND_NOT_OVER")
    expect(text).toContain("isOver() never became true")
  }, 30_000)

  test("a passing report says so", async () => {
    const subject = await loadSubject(join(FIXTURES, "conforming"))
    const report = await validate(subject, {
      seeds: ["t1"],
      only: ["manifest"],
    })
    expect(formatReport(report)).toContain("all checks passed")
  }, 30_000)
})
