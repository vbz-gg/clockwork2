/**
 * What the conformance suite reports.
 *
 * Every finding carries a stable error code from the kernel's table. The
 * agent skill's failure-modes reference is keyed on those codes, the
 * submission pipeline routes on them, and a developer greps for them. Prose
 * can change; a code is a promise.
 */

import type { ErrorCode, GameModule, Manifest } from "../index.js"

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
  /**
   * The numbers behind the note, for a platform to read rather than parse.
   * The performance check reports `microsecondsPerTick`, `peakMemoryBytes`
   * and the engine that measured them, `memoryEngine`.
   */
  readonly measurements?: Readonly<Record<string, number | string>>
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
  /**
   * The bytes of the game's data packs, by manifest path, unchecked. The
   * suite checks them once and gives the result to every session it runs, so
   * a pack that is missing or wrong is reported with its own code by every
   * check that runs the game.
   */
  readonly packs?: ReadonlyMap<string, Uint8Array>
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
