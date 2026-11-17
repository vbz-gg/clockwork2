/**
 * @clockwork2/validate
 *
 * The conformance suite. Where this prose and `scripts/validate` disagree, the
 * script is right.
 */

export { CHECK_SETS } from "./checks/index.js"
export {
  SENSITIVITY_SEEDS,
  SENSITIVITY_TICKS,
} from "./checks/ranked.js"
export { CHECK_WINDOW_TICKS } from "./checks/support.js"
export { findEntry, loadSubject, readPacks } from "./load.js"
export {
  DEFAULT_SEEDS,
  formatReport,
  type ValidateOptions,
  validate,
} from "./runner.js"
export {
  BANNED_GLOBALS,
  BANNED_IMPORTS,
  BANNED_MEMBERS,
  BANNED_PROPERTIES,
} from "./scan/banned.js"
export {
  type ScanFinding,
  type ScanFindingKind,
  type ScanOptions,
  type ScanResult,
  scanImportGraph,
} from "./scan/import-graph.js"
export type {
  Check,
  CheckContext,
  CheckOutcome,
  CheckSet,
  Finding,
  Report,
  RunEnd,
  Subject,
} from "./types.js"
