/**
 * What the conformance suite reports.
 *
 * Every finding carries a stable error code from the kernel's table. The
 * agent skill's failure-modes reference is keyed on those codes, the
 * submission pipeline routes on them, and a developer greps for them. Prose
 * can change; a code is a promise.
 */

import type { ErrorCode, GameModule, Manifest } from ".."

export type Finding = {
  readonly code: ErrorCode
  /** Which check produced it. */
  readonly check: string
  readonly detail: string
  /** Where in the session, when that is known. */
  readonly tick?: number
  /** Where in the source, when that is known. */
  readonly at?: string
}

export type CheckOutcome = {
  readonly check: string
  readonly title: string
  readonly ok: boolean
  /** Set when a check could not run at all, rather than ran and failed. */
  readonly skipped?: string
  readonly findings: readonly Finding[]
  /** Anything worth printing on a pass: a measurement, a count. */
  readonly note?: string
  readonly ms: number
}

export type Report = {
  readonly ok: boolean
  readonly outcomes: readonly CheckOutcome[]
  readonly ms: number
}

/** What is being checked. */
export type Subject = {
  readonly manifest: Manifest
  /**
   * Produces a module instance.
   *
   * The platform evaluates the module afresh per session rather than taking a
   * fresh instance, because a fresh instance does not reset a module-level
   * counter - which is exactly what tiki-kong's static ids relied on. Pass
   * `fresh: true` to ask for a newly evaluated module where the caller can
   * provide one.
   */
  readonly load: (options?: {
    readonly fresh?: boolean
  }) => Promise<GameModule> | GameModule
  /** The simulation's entry file, for the static scan. */
  readonly entry?: string
  /** The directory holding the bundle and its assets, for the budget check. */
  readonly root?: string
  /** A default config, when the game takes one. */
  readonly config?: unknown
}

export type CheckContext = {
  readonly subject: Subject
  /** Seeds every check uses, so two runs of the suite are comparable. */
  readonly seeds: readonly string[]
  /** Set false to leave the runtime traps off, for measuring their cost. */
  readonly shims: boolean
}

export type Check = {
  readonly name: string
  readonly title: string
  run(
    context: CheckContext,
  ): Promise<Omit<CheckOutcome, "check" | "title" | "ms">>
}
