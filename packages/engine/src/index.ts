/**
 * @clockwork2/kernel
 *
 * A deterministic, fixed-step simulation kernel. The browser records inputs,
 * the server replays them, and both reach the same state - on V8,
 * JavaScriptCore and SpiderMonkey alike.
 *
 * Subpath entries keep a consumer from pulling in more than it needs:
 * `@clockwork2/kernel/dmath`, `/prng`, `/hash`, `/recording`, `/manifest`,
 * `/testing`, `/probe`.
 */

/**
 * The major of this constant is pinned by a game's manifest. A bundle built
 * against a different kernel major is refused rather than run.
 */
export const KERNEL_VERSION = "0.7.1"

export {
  fromBits,
  fromBitsHex,
  nextDown,
  nextUp,
  toBits,
  toBitsHex,
  ulpDistance,
} from "./bits.js"
export type {
  Counters,
  Effect,
  GameModule,
  GameModuleSource,
  InputDevice,
  InputEvent,
  PlainValue,
  Presentation,
  PresentationContext,
  Snapshot,
  TerminalReason,
} from "./contract.js"
export { INPUT_DEVICES, instantiate, TERMINAL_REASONS } from "./contract.js"
export {
  type CounterDeclaration,
  type CounterDirection,
  CounterTracker,
  compareByRank,
  meetsThreshold,
  type RankBy,
  TIE_POLICIES,
  type TiePolicy,
} from "./counters.js"
export * as dmath from "./dmath/index.js"
export {
  ClockworkError,
  ERROR_CODES,
  type ErrorCode,
  fail,
  isClockworkError,
} from "./errors.js"
export * as fixed from "./fixed.js"
export { encodeCanonical, Hash64, hash64, hashCanonical } from "./hash/index.js"
export {
  type AxisOptions,
  type InputSource,
  LiveInputQueue,
  type PendingInput,
  quantiseAxis,
  quantisePoint,
  RecordedInputSource,
  validateInputLog,
} from "./inputs.js"
export {
  Accumulator,
  type AccumulatorOptions,
  type Checkpoint,
  DEFAULT_MAX_CATCHUP_TICKS,
  DEFAULT_MAX_FRAME_MS,
  runSession,
  Session,
  type SessionOptions,
  type SessionResult,
} from "./loop.js"
export type {
  Manifest,
  ParamSchema,
  ParamValues,
  TickRate,
} from "./manifest/index.js"
export {
  assertManifest,
  mergeParamDefaults,
  validateManifest,
  validateParams,
} from "./manifest/index.js"
export { lerp, lerpAngle, NodeSet } from "./presentation/index.js"
export { Prng, type PrngState } from "./prng/index.js"
export type { Recording } from "./recording/index.js"
export {
  compareToRecording,
  decodeRecording,
  encodeRecording,
  RECORDING_FORMAT,
  RECORDING_VERSION,
} from "./recording/index.js"
export {
  installShims,
  shimsInstalled,
  uninstallShims,
  unshimmableApis,
  withShims,
} from "./shims.js"
export { Timer, type TimerHandler, type TimerState } from "./timer.js"
