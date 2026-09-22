/**
 * The runner, and how a thrown error becomes a reported code.
 *
 * The contract stated in runner.ts is that a submission which crashes the suite
 * must still produce a report. Nothing tested it. A runner that let one check's
 * throw escape would hand a developer a stack trace instead of the eleven
 * other results they need, and the one thing a conformance report must never do
 * is stop early.
 */

import { describe, expect, test } from "bun:test"
import { ClockworkError } from "../../src"
import { CHECKS } from "../../src/validate/checks/index"
import { codeFromError } from "../../src/validate/checks/support"
import {
  DEFAULT_SEEDS,
  formatReport,
  validate,
} from "../../src/validate/runner"
import type { Report, Subject } from "../../src/validate/types"

/** A Subject whose every load throws, so every check fails the same way. */
function exploding(error: unknown): Subject {
  return {
    manifest: {
      schemaVersion: 1,
      id: "explodes",
      version: "1.0.0",
      name: "Explodes",
      kernel: { version: "0.1.0" },
      session: {
        tickHz: 60,
        maxTicks: 600,
        maxWallSeconds: 120,
        hasEnding: true,
      },
      inputs: { map: { push: [{ code: "Space", device: "key" }] } },
      counters: [{ name: "score", direction: "up", monotonic: true }],
      rankBy: ["score"],
      tiePolicy: "shared",
      capabilities: {
        deterministic: true,
        physics: "none",
        renderer: "canvas2d",
        multiplayer: false,
      },
    },
    load: () => {
      throw error
    },
  }
}

describe("a check that throws", () => {
  test("is a failed check, and the rest of the suite still runs", async () => {
    const report = await validate(exploding(new Error("the wheels came off")), {
      seeds: ["s1"],
    })
    expect(report.outcomes.length).toBe(CHECKS.length)
    expect(report.ok).toBe(false)
  }, 30_000)

  /**
   * A plain Error carries no code, so the runner falls back to E_CHECK_THREW
   * rather than inventing one. That is the code a developer greps for when the
   * suite itself is the thing that broke.
   */
  test("with no code of its own is reported as E_CHECK_THREW", async () => {
    const report = await validate(exploding(new Error("the wheels came off")), {
      seeds: ["s1"],
      // The replay check is the one that lets a load error escape to the
      // runner. Most checks catch and report their own; this is the path that
      // proves the runner does not need them to.
      only: ["replay"],
    })
    const finding = report.outcomes[0]?.findings[0]
    expect(finding?.code).toBe("E_CHECK_THREW")
    expect(finding?.detail).toContain("the check itself threw")
    expect(finding?.detail).toContain("the wheels came off")
  }, 30_000)

  /**
   * A run that died because a runtime trap fired has to report the trap, not
   * whichever check was driving. Reporting E_CHECK_THREW for a game that called
   * Math.random would send a developer looking in the wrong place entirely.
   */
  test("carrying a code reports that code instead", async () => {
    const report = await validate(
      exploding(new ClockworkError("E_BANNED_API", { detail: "Math.random" })),
      { seeds: ["s1"], only: ["replay"] },
    )
    expect(report.outcomes[0]?.findings[0]?.code).toBe("E_BANNED_API")
  }, 30_000)
})

describe("codeFromError", () => {
  test("takes the code off a ClockworkError", () => {
    expect(
      codeFromError(new ClockworkError("E_ASYNC_TICK"), "E_CHECK_THREW"),
    ).toBe("E_ASYNC_TICK")
  })

  /**
   * An error that crossed a worker or a structured clone arrives as a plain
   * Error with the code only in its text. Reading it back beats reporting the
   * fallback, which would name the wrong layer.
   */
  test("reads a code out of the text when the error is no longer one of ours", () => {
    expect(
      codeFromError(
        new Error("E_RESTORE_MISMATCH@1800 while resuming"),
        "E_CHECK_THREW",
      ),
    ).toBe("E_RESTORE_MISMATCH")
  })

  test("ignores something that only looks like a code", () => {
    // Otherwise a game could put E_NOT_A_REAL_CODE in a message and the report
    // would carry a code nothing documents.
    expect(
      codeFromError(new Error("E_NOT_A_REAL_CODE happened"), "E_CHECK_THREW"),
    ).toBe("E_CHECK_THREW")
  })

  test("falls back when there is no code anywhere", () => {
    expect(codeFromError("just a string", "E_HEADLESS_THREW")).toBe(
      "E_HEADLESS_THREW",
    )
  })
})

describe("only", () => {
  test("runs just the checks named", async () => {
    const report = await validate(exploding(new Error("x")), {
      seeds: ["s1"],
      only: ["bound", "restore"],
    })
    expect(report.outcomes.map((o) => o.check)).toEqual(["bound", "restore"])
  }, 30_000)

  test("reports progress as each check starts", async () => {
    // The CLI prints this, and a suite that says nothing for a minute reads as
    // a hang.
    const seen: string[] = []
    await validate(exploding(new Error("x")), {
      seeds: ["s1"],
      only: ["bound", "restore"],
      onProgress: (name) => seen.push(name),
    })
    expect(seen).toEqual(["bound", "restore"])
  }, 30_000)
})

describe("formatReport", () => {
  function reportWith(
    findings: Report["outcomes"][number]["findings"],
  ): Report {
    return {
      ok: false,
      ms: 12,
      outcomes: [
        {
          check: "banned-apis",
          title: "Nothing in the import graph names a banned API",
          ok: false,
          findings,
          ms: 3,
        },
      ],
    }
  }

  /**
   * A finding about source carries `at` and no tick, and the file and line are
   * the whole value of it. A formatter that only printed the tick would drop
   * them and leave a developer to search the bundle by hand.
   */
  test("prints the source location of a finding that has one", () => {
    const text = formatReport(
      reportWith([
        {
          code: "E_LINT_BANNED",
          check: "banned-apis",
          detail: "Math.random: use Prng",
          at: "src/sim.ts:42:7",
        },
      ]),
    )
    expect(text).toContain("E_LINT_BANNED src/sim.ts:42:7")
    expect(text).toContain("Math.random: use Prng")
  })

  test("prints the tick of a finding that has one", () => {
    const text = formatReport(
      reportWith([
        {
          code: "E_RESTORE_MISMATCH",
          check: "banned-apis",
          detail: "resuming at 600 ended elsewhere",
          tick: 600,
        },
      ]),
    )
    expect(text).toContain("E_RESTORE_MISMATCH@600")
  })

  test("names every failed check in the summary line", () => {
    const text = formatReport({
      ok: false,
      ms: 1000,
      outcomes: [
        { check: "bound", title: "t", ok: false, findings: [], ms: 1 },
        { check: "restore", title: "t", ok: false, findings: [], ms: 1 },
        { check: "manifest", title: "t", ok: true, findings: [], ms: 1 },
      ],
    })
    expect(text).toContain("2 check(s) failed: bound, restore")
  })

  test("a skipped check reads as skipped, not as a pass", () => {
    // A skip printed as a pass is how a check quietly stops running.
    const text = formatReport({
      ok: true,
      ms: 5,
      outcomes: [
        {
          check: "render-smoke",
          title: "t",
          ok: true,
          skipped: "no render bundle was given",
          findings: [],
          ms: 1,
        },
      ],
    })
    expect(text).toContain("skip")
    expect(text).toContain("no render bundle was given")
  })
})

describe("DEFAULT_SEEDS", () => {
  test("is more than one, because one seed proves nothing about determinism", () => {
    expect(DEFAULT_SEEDS.length).toBeGreaterThan(1)
    expect(new Set(DEFAULT_SEEDS).size).toBe(DEFAULT_SEEDS.length)
  })
})
