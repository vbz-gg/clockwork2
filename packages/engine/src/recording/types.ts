/**
 * What a recording is.
 *
 * There is no delta array. In Clockwork 1 a recording carried one entry per
 * frame - about 18,000 for five minutes - and those deltas were the timing
 * data, which meant the client decided how much simulation ran. Here an
 * input's tick is the only timing data there is, and it is enough, because the
 * step size is fixed by the manifest rather than by the player's display.
 *
 * Checkpoints are not needed to replay. Replay is fully determined by the
 * seed, the config, the inputs and `endTick`. They exist so that a divergence
 * can be placed in the second it happened rather than hunted through a
 * five-minute run.
 */

import type {
  Counters,
  InputEvent,
  PlainValue,
  TerminalReason,
} from "../contract"
import type { Checkpoint } from "../loop"
import type { TickRate } from "../manifest/types"

export const RECORDING_FORMAT = "cw2-recording"

/**
 * Bumped whenever a field changes meaning. `decodeRecording` checks it, which
 * game-base's envelope did not: it wrote a version and read it nowhere, while
 * changing codec twice underneath.
 */
export const RECORDING_VERSION = 1

export type Recording = {
  readonly format: typeof RECORDING_FORMAT
  readonly version: number
  /** The kernel that produced it. A different major cannot be replayed here. */
  readonly kernelVersion: string
  readonly gameId: string
  readonly gameVersion: string
  /** Hash of the manifest the session ran under. */
  readonly manifestHash: string
  readonly tickHz: TickRate
  readonly seed: string
  readonly config: PlainValue
  /** Sorted by tick. */
  readonly inputs: readonly InputEvent[]
  /** One per second of play, plus tick 0 and the last tick. */
  readonly checkpoints: readonly Checkpoint[]
  readonly endTick: number
  readonly terminal: TerminalReason
  /** What the client claims. The server compares this against its own replay. */
  readonly counters: Counters
}

type AssertPlain<T extends PlainValue> = T
export type RecordingIsPlain = AssertPlain<Recording>
