/**
 * Hooks the end-to-end suite drives.
 *
 * This module is behind a build flag and a dynamic import, so a production
 * build drops it entirely. `scripts/check-no-test-hooks.ts` greps the built
 * output to prove that rather than trusting it, and the smoke spec asserts
 * `window.__cw2test` is undefined in the production bundle. A bundler flag
 * nobody verifies is a bundler flag that eventually stops working.
 */

import {
  GameHost,
  type LoopStats,
  ManualScheduler,
} from "@clockwork2/host-bridge"
import {
  type Checkpoint,
  type Counters,
  decodeRecording,
  hashCanonical,
  RecordedInputSource,
  type Recording,
  type Snapshot,
} from "@clockwork2/kernel"
import { createGame, MANIFEST, type SnakeConfig } from "../game/index"

export type FrameSchedule =
  | { readonly kind: "fixed"; readonly ms: number }
  /** Cycles through the list, for jitter a real display would produce. */
  | { readonly kind: "pattern"; readonly ms: readonly number[] }
  /** A fixed rate with one long stall in the middle, for a backgrounded tab. */
  | {
      readonly kind: "stall"
      readonly ms: number
      readonly atFrame: number
      readonly stallMs: number
    }

export interface FixedRunResult {
  readonly endTick: number
  readonly terminal: string
  readonly counters: Counters
  readonly checkpoints: readonly Checkpoint[]
  readonly stats: LoopStats
  /**
   * The state the throwaway run finished in.
   *
   * It is here because a spec that wants a snapshot part way through a
   * recording has nowhere else to get one: `snapshot()` reads the *visible*
   * session, which is a different game entirely.
   */
  readonly snapshot: Snapshot
}

export interface Cw2TestApi {
  readonly apiVersion: 1
  /** The live session's tick, counters and whether it is still going. */
  state(): {
    tick: number
    counters: Counters
    running: boolean
    applesEaten: number
  }
  stateHash(): string
  /** The live session's view, so a spec can play rather than press at random. */
  view(): unknown
  checkpoints(): readonly Checkpoint[]
  recording(): Recording
  loopStats(): LoopStats
  snapshot(): Snapshot
  /** Ends the live session, so a spec can take its recording. */
  stop(): void
  /** Starts a fresh live session on a stated seed. */
  reset(seed: string): void
  /**
   * Replays a fixed input log under a synthetic frame schedule, headlessly,
   * without disturbing the visible game.
   *
   * This is the frame-rate invariance check: the same log under wildly
   * different pacing has to reach the same checkpoints. It runs in the page,
   * on the page's own engine, which is the thing being tested.
   */
  runFixedLog(
    recording: Recording | string,
    schedule: FrameSchedule,
  ): FixedRunResult
  /** Restores into a freshly built module and continues, for check 6. */
  restoreAndContinue(
    snapshot: Snapshot,
    tick: number,
    recording: Recording | string,
  ): FixedRunResult
}

function scheduleFrames(
  scheduler: ManualScheduler,
  schedule: FrameSchedule,
  frame: number,
): void {
  switch (schedule.kind) {
    case "fixed":
      scheduler.advance(schedule.ms)
      return
    case "pattern":
      scheduler.advance(schedule.ms[frame % schedule.ms.length] as number)
      return
    default:
      scheduler.advance(
        frame === schedule.atFrame ? schedule.stallMs : schedule.ms,
      )
  }
}

function runHeadless(
  recording: Recording,
  schedule: FrameSchedule,
  resumeFrom?: { snapshot: Snapshot; tick: number },
): FixedRunResult {
  const host = new GameHost({
    module: createGame(),
    manifest: MANIFEST,
    seed: recording.seed,
    config: recording.config as unknown as SnakeConfig,
    inputs: new RecordedInputSource(recording.inputs),
    scheduler: new ManualScheduler(),
    checkpointEvery: 60,
    // A recording that was stopped mid-run ends where the player stopped.
    // Without this the replay carries on past it and reports a different end
    // tick for a session that never diverged.
    maxTicks: Math.max(recording.endTick, 1),
    ...(resumeFrom === undefined ? {} : { resumeFrom }),
  })
  const scheduler = (
    host as unknown as { options: { scheduler: ManualScheduler } }
  ).options.scheduler
  host.start()
  for (let frame = 0; frame < 400_000 && host.status !== "ended"; frame++) {
    scheduleFrames(scheduler, schedule, frame)
  }
  if (host.status !== "ended") host.stop()
  const result = host.result()
  return {
    endTick: result.endTick,
    terminal: result.terminal,
    counters: result.counters,
    checkpoints: result.checkpoints,
    stats: host.stats,
    snapshot: result.snapshot,
  }
}

export function installTestApi(
  host: GameHost<unknown, HTMLElement>,
  controls: { stop: () => void; reset: (seed: string) => void },
): void {
  const api: Cw2TestApi = {
    apiVersion: 1,
    state: () => ({
      tick: host.tick,
      counters: host.counters(),
      running: host.status === "running",
      applesEaten: (host.counters().applesEaten as number) ?? 0,
    }),
    stateHash: () => hashCanonical(host.snapshot()),
    view: () => host.view(),
    checkpoints: () => host.result().checkpoints,
    recording: () => host.recording(),
    loopStats: () => host.stats,
    snapshot: () => host.snapshot(),
    stop: () => {
      controls.stop()
    },
    reset: (seed) => {
      controls.reset(seed)
    },
    runFixedLog: (recording, schedule) =>
      runHeadless(
        typeof recording === "string" ? decodeRecording(recording) : recording,
        schedule,
      ),
    restoreAndContinue: (snapshot, tick, recording) =>
      runHeadless(
        typeof recording === "string" ? decodeRecording(recording) : recording,
        { kind: "fixed", ms: 1000 / 60 },
        { snapshot, tick },
      ),
  }
  ;(globalThis as unknown as Record<string, unknown>).__cw2test = api
}

declare global {
  interface Window {
    __cw2test?: Cw2TestApi
  }
}
