/**
 * @clockwork2/validate
 *
 * The conformance suite. Where this prose and `scripts/validate` disagree, the
 * script is right.
 */

export { CHECKS } from "./checks/index"
export { findEntry, loadSubject } from "./load"
export {
  DEFAULT_SEEDS,
  formatReport,
  type ValidateOptions,
  validate,
} from "./runner"
export {
  BANNED_GLOBALS,
  BANNED_IMPORTS,
  BANNED_MEMBERS,
  BANNED_PROPERTIES,
} from "./scan/banned"
export {
  type ScanFinding,
  type ScanFindingKind,
  type ScanOptions,
  type ScanResult,
  scanImportGraph,
} from "./scan/import-graph"
export type {
  Check,
  CheckContext,
  CheckOutcome,
  Finding,
  Report,
  Subject,
} from "./types"
