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
  /**
   * An input log entry no recording can hold: a tick or a value that is not a
   * whole number, a `-0`, no name, or a tick outside the run or the span.
   */
  E_INPUT_RANGE: "input value is out of range",
  /** An input the manifest does not declare, or a value outside its declared range. */
  E_INPUT_UNDECLARED:
    "an input is not one the manifest declares, or is out of its range",
  /** A log holding more inputs than the budget allows (`checkInputs`). */
  E_INPUT_BUDGET: "a log holds more inputs than any player makes",

  // --- seats --------------------------------------------------------------
  /**
   * A game with several seats has no `seat()`, or `seat()` answered something
   * other than a whole number below the seat count.
   */
  E_SEAT_INVALID:
    "seat() is missing on a game with several seats, or named a seat the run does not have",
  /** A seat's inputs landed on a tick that was another seat's turn. */
  E_INPUT_SEAT: "an input landed on a tick that was another seat's turn",
  /** A tick's inputs were read from a feed before its sender confirmed them. */
  E_INPUT_NOT_CONFIRMED:
    "a tick's inputs were read from a network feed before the sender confirmed that tick",
  /** A manifest failed validation. */
  E_MANIFEST_INVALID: "manifest is invalid",
  /** An argument the caller controls was outside the range the API accepts. */
  E_ARG_INVALID: "an argument is outside the range this API accepts",
  /** The host cannot supply something the engine needs to run correctly. */
  E_ENV_UNSUPPORTED: "this environment cannot run the engine correctly",
  /** A presentation's `prepare()` rejected, so the session never started. */
  E_PRESENTATION_FAILED:
    "the presentation could not get ready to draw, so the session never started",

  // --- data packs ---------------------------------------------------------
  /** A pack was named that the manifest does not declare as one. */
  E_PACK_UNDECLARED:
    "a pack was named that the manifest does not declare with requiredForSim",
  /** The game read a pack outside the steps it asked for it. */
  E_PACK_NOT_REQUESTED:
    "the simulation read a pack it had not asked for at this step",
  /** A pack the session needs has not been handed over. */
  E_PACK_NOT_DELIVERED: "a pack the session needs was not delivered",
  /** A pack's bytes are not the ones its manifest entry declares. */
  E_PACK_HASH_MISMATCH:
    "a pack's bytes do not match the sha256 and size its manifest declares",
  /** A pack is longer than its manifest entry declares. */
  E_PACK_TOO_LARGE: "a pack is larger than its manifest declares",

  // --- conformance suite --------------------------------------------------
  /** Two runs of the same seed, config and inputs reached different states. */
  E_DETERMINISM_DIVERGED:
    "two runs of the same session reached different states",
  /** The module threw when loaded or stepped with no browser present. */
  E_HEADLESS_THREW: "module threw in a headless run",
  /** The static scan found a banned API in the simulation's import graph. */
  E_LINT_BANNED: "a banned API appears in the simulation's import graph",
  /** await, async or .then appears in the simulation, or a microtask changed state. */
  E_ASYNC_DETECTED: "asynchronous work in the simulation",
  /** restore-then-continue did not equal continue. */
  E_RESTORE_MISMATCH: "restore-then-continue diverged from continue",
  /** A declared file is missing or wrong, or the assets exceed their budget. */
  E_BUDGET_EXCEEDED:
    "a declared asset is missing, misdeclared or over the asset budget",
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
  /** A check threw while running, which is itself a failure of the subject. */
  E_CHECK_THREW: "a conformance check threw while running",
  /** The subject could not be loaded: no entry file, or no module to run. */
  E_SUBJECT_LOAD: "the subject could not be loaded",

  // --- conformance suite, ranked set ---------------------------------------
  /** Two seeds passed through the same states on every log the seed check plays. */
  E_SEED_IGNORED:
    "two seeds passed through the same states on every log; the seed decides nothing",
  /** The manifest says nothing about how a run ranks. */
  E_RANK_UNDECLARED:
    "the manifest declares no rankBy and tiePolicy, which a ranked run needs",
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
 * The mark every `ClockworkError` carries. `Symbol.for` returns one symbol
 * per name across every copy of the engine in a page or a process, so an
 * error thrown by one copy is recognised by another, where `instanceof` would
 * compare two different classes and say no.
 */
const CLOCKWORK_ERROR = Symbol.for("clockwork2.error")

/**
 * The one error type. Catching code switches on `code`, never on the message,
 * and never on a substring of it, and recognises one with `isClockworkError`,
 * never `instanceof`, because a page can hold two copies of the engine.
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
    Object.defineProperty(this, CLOCKWORK_ERROR, { value: true })
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
  if (typeof value !== "object" || value === null) return false
  const marked = value as {
    readonly [CLOCKWORK_ERROR]?: unknown
    readonly code?: unknown
  }
  return (
    marked[CLOCKWORK_ERROR] === true &&
    typeof marked.code === "string" &&
    Object.hasOwn(ERROR_CODES, marked.code)
  )
}
