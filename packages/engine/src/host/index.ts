/**
 * @clockwork2/host-bridge
 *
 * The loop, the input capture and the frame protocol. Subpaths keep the halves
 * apart: `./parent` runs in the platform's page, `./frame` inside the
 * sandboxed game document, `./worker` inside the simulation worker, and
 * `./protocol` is the message table both sides read.
 */

export { AudioSink, type AudioSinkOptions, type SoundRecipe } from "./audio.js"
export { browserScheduler, ManualScheduler, type Scheduler } from "./clock.js"
export {
  type FrameInfo,
  GameHost,
  type GameHostOptions,
  type HostState,
  type LoopStats,
} from "./host.js"
export {
  type ActionBinding,
  bindingsFrom,
  InputCapture,
  type InputCaptureOptions,
} from "./input.js"
export {
  createDispatcher,
  FRAME_ERRORS,
  type GameToHost,
  type HandlerTable,
  type HostToGame,
  LOG_CHUNK_INTERVAL_MS,
  PROGRESS_INTERVAL_MS,
  PROTOCOL_VERSION,
} from "./protocol/index.js"
