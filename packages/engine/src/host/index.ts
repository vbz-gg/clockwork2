/**
 * @clockwork2/host-bridge
 *
 * Running a game in a page: the loop, pack loading, and the optional device
 * helpers that turn keys, pointers, the wheel, gamepads and tilt into a
 * game's own inputs. `./worker` is the second host, for a simulation that
 * runs in a worker.
 */

export { AudioSink, type AudioSinkOptions, type SoundRecipe } from "./audio.js"
export { browserScheduler, ManualScheduler, type Scheduler } from "./clock.js"
export {
  type FrameInfo,
  GameHost,
  type GameHostOptions,
  type HostState,
  type LoopStats,
  type SeatOptions,
} from "./host.js"
export {
  type CaptureDocument,
  type CaptureEnvironment,
  type CaptureMapping,
  checkCapture,
  DEVICE_NOTICES,
  type DeviceNotice,
  type DeviceNoticeCode,
  GAMEPAD_AXES,
  GAMEPAD_BUTTONS,
  GAMEPAD_SLOTS,
  type GamepadMapping,
  InputCapture,
  type InputCaptureOptions,
  POINTER_BUTTONS,
  POINTER_SLOTS,
  type PointerSlot,
  type ScriptedEvents,
  screenRotation,
} from "./input.js"
export {
  currentScreenAngle,
  MOTION_REFUSALS,
  MOTION_WAIT_MS,
  type MotionAccess,
  type MotionEnvironment,
  type MotionRefusal,
  motionEnvironment,
  requestMotion,
  type ScreenAngleSource,
  screenAngleOf,
} from "./motion.js"
export {
  type FetchPackLoaderOptions,
  fetchPackLoader,
  loadPacks,
  memoryPackLoader,
  type PackLoader,
  type PackSupply,
} from "./packs.js"
