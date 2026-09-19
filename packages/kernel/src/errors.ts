/**
 * Every failure this kernel and its conformance suite can report, as a stable
 * code. The codes are the contract: the agent skill's failure-modes reference
 * is keyed on them, the submission pipeline routes on them, and a developer
 * reads them in a log. Renaming one is a breaking change.
 */

export const ERROR_CODES = {
  // --- kernel, at runtime -------------------------------------------------
  /** tick() returned a thenable. The loop is synchronous by construction. */
  E_ASYNC_TICK:
    "tick() returned a thenable; the simulation must be synchronous",
  /** A shimmed global was touched during init() or tick(). */
  E_BANNED_API: "a banned global was used inside the simulation",
  /** Prng was constructed without a seed. There is no unseeded path. */
  E_SEED_REQUIRED: "a seed is required; there is no unseeded PRNG",
  /** An argument fell outside the range a dmath routine can reduce exactly. */
  E_DMATH_RANGE: "argument outside the exactly reducible range",
  /** A snapshot held a value the canonical encoder refuses to encode. */
  E_CANONICAL_UNSUPPORTED:
    "snapshot holds a value with no canonical encoding (NaN, Infinity, undefined, a function or a class instance)",
  /** A counter declared monotone moved the wrong way. */
  E_COUNTER_REVERSED: "a monotone counter moved the wrong way",
  /** A counter was not a finite integer inside 53 bits. */
  E_COUNTER_RANGE: "a counter is not a finite integer within 53 bits",
  /** isOver() returned false after returning true. */
  E_OVER_FLIPPED: "isOver() went back to false",
  /** A recording carried a format or version this kernel does not read. */
  E_RECORDING_VERSION: "recording format or version is not readable here",
  /** A recording failed its structural checks. */
  E_RECORDING_MALFORMED: "recording is malformed",
  /** An input log was not sorted by tick. */
  E_INPUT_UNSORTED: "input log is not sorted by tick",
  /** An input carried a value outside the range the device vocabulary allows. */
  E_INPUT_RANGE: "input value is out of range",
  /** The session passed the tick cap its manifest declares. */
  E_TICK_LIMIT: "session passed maxTicks without ending",
  /** A manifest failed validation. */
  E_MANIFEST_INVALID: "manifest is invalid",

  // --- conformance suite --------------------------------------------------
  /** Two runs of the same seed, config and inputs reached different states. */
  E_DETERMINISM_DIVERGED:
    "two runs of the same session reached different states",
  /** The module threw when loaded or stepped with no browser present. */
  E_HEADLESS_THREW: "module threw in a headless run",
  /** isOver() never became true inside maxTicks. */
  E_BOUND_NOT_OVER: "the run does not end inside maxTicks",
  /** The static scan found a banned API in the simulation's import graph. */
  E_LINT_BANNED: "a banned API appears in the simulation's import graph",
  /** await, async or .then appears in the simulation, or a microtask changed state. */
  E_ASYNC_DETECTED: "asynchronous work in the simulation",
  /** restore-then-continue did not equal continue. */
  E_RESTORE_MISMATCH: "restore-then-continue diverged from continue",
  /** A file or the bundle exceeded its declared budget, or was undeclared. */
  E_BUDGET_EXCEEDED: "bundle or asset budget exceeded, or a file is undeclared",
  /** The simulation was slower per tick than the performance budget allows. */
  E_PERF_BUDGET: "per-tick cost above the budget",
  /** A recording did not replay to the state it was recorded from. */
  E_REPLAY_MISMATCH: "replay did not reproduce the recorded state",
  /** The manifest failed its JSON Schema. */
  E_MANIFEST_SCHEMA: "manifest failed schema validation",
  /** The bundle touched a global the sandbox forbids. */
  E_GLOBALS_TOUCHED: "the bundle touched a forbidden global",
  /** The render bundle failed its smoke check. */
  E_RENDER_SMOKE: "render smoke check failed",
} as const

export type ErrorCode = keyof typeof ERROR_CODES

export interface ClockworkErrorOptions {
  /** Where in the session it happened, when that is known. */
  readonly tick?: number
  /** Anything that makes the failure actionable: a file, an API name, a hash. */
  readonly detail?: string
  readonly cause?: unknown
}

/**
 * The one error type. Catching code switches on `code`, never on the message,
 * and never on a substring of it.
 */
export class ClockworkError extends Error {
  readonly code: ErrorCode
  readonly tick: number | undefined
  readonly detail: string | undefined

  constructor(code: ErrorCode, options: ClockworkErrorOptions = {}) {
    const where = options.tick === undefined ? "" : `@${options.tick}`
    const what = options.detail === undefined ? "" : `: ${options.detail}`
    super(`${code}${where} ${ERROR_CODES[code]}${what}`, {
      cause: options.cause,
    })
    this.name = "ClockworkError"
    this.code = code
    this.tick = options.tick
    this.detail = options.detail
  }

  /** The short form a log line or a CLI prints: `E_RESTORE_MISMATCH@1800`. */
  get tag(): string {
    return this.tick === undefined ? this.code : `${this.code}@${this.tick}`
  }
}

export function fail(code: ErrorCode, options?: ClockworkErrorOptions): never {
  throw new ClockworkError(code, options)
}

export function isClockworkError(value: unknown): value is ClockworkError {
  return value instanceof ClockworkError
}
