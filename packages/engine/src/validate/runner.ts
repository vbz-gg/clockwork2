/**
 * Running the suite.
 *
 * Every check runs even when an earlier one failed, because a developer
 * fixing a submission wants the whole list rather than one item at a time.
 */

import { fail } from "../index.js"
import { CHECK_SETS } from "./checks/index.js"
import { codeFromError } from "./checks/support.js"
import type {
  CheckOutcome,
  CheckSet,
  Report,
  RunEnd,
  Subject,
} from "./types.js"

export interface ValidateOptions {
  /**
   * Which checks run: `every-game`, what any game on the engine needs, or
   * `ranked`, those and the checks a ranked or practice run on a platform
   * needs. Required, so every caller says which question it is asking.
   */
  readonly set: CheckSet
  /** Seeds every check runs against. More seeds, more confidence, more time. */
  readonly seeds?: readonly string[]
  /** Run only these checks of the set, by name. A name the set lacks throws. */
  readonly only?: readonly string[]
  /** Set false to leave the runtime traps off, for measuring their cost. */
  readonly shims?: boolean
  readonly onProgress?: (name: string) => void
}

export const DEFAULT_SEEDS = ["conformance-1", "conformance-2", "conformance-3"]

/**
 * The longest check name in any set, which sizes the name column of a
 * printed report and the CLI's progress line, so every name fits with room
 * after it.
 */
export const CHECK_NAME_WIDTH = Math.max(
  ...Object.values(CHECK_SETS).flatMap((checks) =>
    checks.map((check) => check.name.length),
  ),
)

/**
 * Runs a set of checks against a subject and reports every outcome.
 *
 * @throws E_ARG_INVALID for a set that does not exist, or an `only` naming a
 *   check the set does not run, before any check runs
 */
export async function validate(
  subject: Subject,
  options: ValidateOptions,
): Promise<Report> {
  const checks = Object.hasOwn(CHECK_SETS, options.set)
    ? CHECK_SETS[options.set]
    : fail("E_ARG_INVALID", {
        detail: `set must be one of ${Object.keys(CHECK_SETS).join(", ")}, got ${JSON.stringify(options.set)}`,
      })
  const seeds = options.seeds ?? DEFAULT_SEEDS
  const only = options.only === undefined ? null : new Set(options.only)
  if (only !== null) {
    const unknown = [...only].filter(
      (name) => !checks.some((check) => check.name === name),
    )
    if (unknown.length > 0) {
      fail("E_ARG_INVALID", {
        detail: `only names ${unknown.join(", ")}, which the ${options.set} set does not run`,
      })
    }
  }
  const outcomes: CheckOutcome[] = []
  const startedAll = Date.now()

  for (const check of checks) {
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
    set: options.set,
    ok: outcomes.every((outcome) => outcome.ok),
    outcomes,
    ms: Date.now() - startedAll,
  }
}

/**
 * Where each run ended, one line per seed: `conformance-1: idle ended at
 * 3600, chaos ran the whole window (36000), bot ended at 2210`.
 */
function endLines(ends: readonly RunEnd[]): string[] {
  const bySeed = new Map<string, string[]>()
  for (const end of ends) {
    const said =
      end.terminal === "timeout"
        ? `${end.log} ran the whole window (${end.endTick})`
        : `${end.log} ended at ${end.endTick}`
    bySeed.set(end.seed, [...(bySeed.get(end.seed) ?? []), said])
  }
  return [...bySeed].map(([seed, said]) => `${seed}: ${said.join(", ")}`)
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
      `${mark}  ${outcome.check.padEnd(CHECK_NAME_WIDTH)} ${String(outcome.ms).padStart(6)}ms  ${outcome.title}`,
    )
    if (note !== "") lines.push(`      ${note}`)
    for (const line of endLines(outcome.ends ?? [])) lines.push(`      ${line}`)
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
      ? `all checks in the ${report.set} set passed in ${(report.ms / 1000).toFixed(1)}s`
      : `${failed.length} check(s) in the ${report.set} set failed: ${failed.map((o) => o.check).join(", ")}`,
  )
  return lines.join("\n")
}
