/**
 * Running the suite.
 *
 * Every check runs even when an earlier one failed, because a developer
 * fixing a submission wants the whole list rather than one item at a time.
 */

import { CHECKS } from "./checks/index.js"
import { codeFromError } from "./checks/support.js"
import type { CheckOutcome, Report, Subject } from "./types.js"

export interface ValidateOptions {
  /** Seeds every check runs against. More seeds, more confidence, more time. */
  readonly seeds?: readonly string[]
  /** Run only these checks, by name. */
  readonly only?: readonly string[]
  /** Set false to leave the runtime traps off, for measuring their cost. */
  readonly shims?: boolean
  readonly onProgress?: (name: string) => void
}

export const DEFAULT_SEEDS = ["conformance-1", "conformance-2", "conformance-3"]

export async function validate(
  subject: Subject,
  options: ValidateOptions = {},
): Promise<Report> {
  const seeds = options.seeds ?? DEFAULT_SEEDS
  const only = options.only === undefined ? null : new Set(options.only)
  const outcomes: CheckOutcome[] = []
  const startedAll = Date.now()

  for (const check of CHECKS) {
    if (only !== null && !only.has(check.name)) continue
    options.onProgress?.(check.name)
    const started = Date.now()
    try {
      const result = await check.run({
        subject,
        seeds,
        shims: options.shims ?? true,
      })
      outcomes.push({
        check: check.name,
        title: check.title,
        ...result,
        ms: Date.now() - started,
      })
    } catch (error) {
      // A check that throws is a failed check, not a failed run. A submission
      // that crashes the suite must still produce a report.
      outcomes.push({
        check: check.name,
        title: check.title,
        ok: false,
        findings: [
          {
            code: codeFromError(error, "E_CHECK_THREW"),
            check: check.name,
            detail: `the check itself threw: ${String(error)}`,
          },
        ],
        ms: Date.now() - started,
      })
    }
  }

  return {
    ok: outcomes.every((outcome) => outcome.ok),
    outcomes,
    ms: Date.now() - startedAll,
  }
}

/** A report as a person reads it. */
export function formatReport(report: Report): string {
  const lines: string[] = []
  for (const outcome of report.outcomes) {
    const mark =
      outcome.skipped !== undefined ? "skip" : outcome.ok ? "pass" : "FAIL"
    const note =
      outcome.skipped !== undefined ? outcome.skipped : (outcome.note ?? "")
    lines.push(
      `${mark}  ${outcome.check.padEnd(14)} ${String(outcome.ms).padStart(6)}ms  ${outcome.title}`,
    )
    if (note !== "") lines.push(`      ${note}`)
    for (const finding of outcome.findings) {
      const where =
        finding.tick !== undefined
          ? `@${finding.tick}`
          : finding.at !== undefined
            ? ` ${finding.at}`
            : ""
      lines.push(`      ${finding.code}${where}`)
      lines.push(`        ${finding.detail}`)
    }
  }
  lines.push("")
  const failed = report.outcomes.filter((o) => !o.ok)
  lines.push(
    report.ok
      ? `all checks passed in ${(report.ms / 1000).toFixed(1)}s`
      : `${failed.length} check(s) failed: ${failed.map((o) => o.check).join(", ")}`,
  )
  return lines.join("\n")
}
