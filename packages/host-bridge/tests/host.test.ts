/**
 * The property the whole project exists for, checked without a browser.
 *
 * A manual scheduler makes frame pacing something a test states rather than
 * something it waits for, so "the same input log at 5 frames a second and at
 * 240 frames a second reaches the same state" is a millisecond to check and
 * cannot go flaky.
 */

import { describe, expect, test } from "bun:test"
import {
  decodeRecording,
  encodeRecording,
  type InputEvent,
  RecordedInputSource,
  runSession,
} from "@clockwork2/kernel"
import {
  botLog,
  createReferenceGame,
  REFERENCE_CONFIG,
  REFERENCE_MANIFEST,
} from "@clockwork2/kernel/testing"
import { GameHost, ManualScheduler } from "../src/index"

function replayHost(log: readonly InputEvent[], scheduler: ManualScheduler) {
  return new GameHost({
    module: createReferenceGame(),
    manifest: REFERENCE_MANIFEST,
    seed: "frame-rate",
    config: REFERENCE_CONFIG,
    inputs: new RecordedInputSource(log),
    scheduler,
    checkpointEvery: 60,
  })
}

describe("frame-rate invariance", () => {
  const log = botLog("invariance", 20_000)

  const PACINGS: Array<[label: string, ms: number]> = [
    ["240 Hz", 1000 / 240],
    ["144 Hz", 1000 / 144],
    ["60 Hz", 1000 / 60],
    ["30 Hz", 1000 / 30],
    ["20 Hz", 50],
    ["5 Hz", 200],
  ]

  test("every frame rate reaches the same state", () => {
    const results = new Map<string, string>()
    for (const [label, ms] of PACINGS) {
      const scheduler = new ManualScheduler()
      const host = replayHost(log, scheduler)
      host.start()
      // Twelve simulated minutes, which is well past the end of the run.
      for (let i = 0; i < Math.ceil(720_000 / ms); i++) {
        if (host.status === "ended") break
        scheduler.advance(ms)
      }
      const result = host.result()
      results.set(
        label,
        JSON.stringify({
          endTick: result.endTick,
          counters: result.counters,
          checkpoints: result.checkpoints,
        }),
      )
    }
    const distinct = new Set(results.values())
    expect(
      distinct.size,
      `frame rates produced ${distinct.size} different games: ${[...results.keys()].join(", ")}`,
    ).toBe(1)
  })

  test("jitter reaches the same state as steady pacing", () => {
    const steady = new ManualScheduler()
    const steadyHost = replayHost(log, steady)
    steadyHost.start()
    while (steadyHost.status !== "ended") steady.advance(1000 / 60)

    const jitter = new ManualScheduler()
    const jitterHost = replayHost(log, jitter)
    jitterHost.start()
    const pattern = [7, 33, 11, 64, 4, 19, 250, 8, 16, 1]
    let i = 0
    while (jitterHost.status !== "ended") {
      jitter.advance(pattern[i % pattern.length] as number)
      i++
      if (i > 200_000) break
    }
    expect(jitterHost.result().endTick).toBe(steadyHost.result().endTick)
    expect(jitterHost.result().checkpoints).toEqual(
      steadyHost.result().checkpoints,
    )
  })

  test("a faster display runs more frames and the same number of ticks", () => {
    const slow = new ManualScheduler()
    const slowHost = replayHost(log, slow)
    slowHost.start()
    while (slowHost.status !== "ended") slow.advance(1000 / 30)

    const fast = new ManualScheduler()
    const fastHost = replayHost(log, fast)
    fastHost.start()
    while (fastHost.status !== "ended") fast.advance(1000 / 240)

    expect(fastHost.stats.frames).toBeGreaterThan(slowHost.stats.frames * 3)
    expect(fastHost.stats.ticksRun).toBe(slowHost.stats.ticksRun)
    // And the slow one really did catch up rather than running one tick a
    // frame, which would make the whole comparison vacuous.
    expect(slowHost.stats.mostTicksInAFrame).toBeGreaterThan(1)
    expect(fastHost.stats.mostTicksInAFrame).toBe(1)
  })
})

describe("a stalled tab", () => {
  test("drops its debt instead of bursting", () => {
    const scheduler = new ManualScheduler()
    const host = replayHost(botLog("stall", 20_000), scheduler)
    host.start()
    for (let i = 0; i < 60; i++) scheduler.advance(1000 / 60)
    const before = host.tick
    // Four minutes in the background.
    scheduler.advance(240_000)
    const after = host.tick
    expect(after - before).toBeLessThanOrEqual(5)
    expect(host.stats.droppedMs).toBeGreaterThan(200_000)
    expect(host.stats.mostTicksInAFrame).toBeLessThanOrEqual(5)
  })

  test("a session that stalled still replays to the state it reached", () => {
    // Dropping time is only correct if the drop is recorded. A host that drops
    // ticks but reports a tick count as though it had not would produce a log
    // that replays to somewhere else.
    const scheduler = new ManualScheduler()
    const host = new GameHost({
      module: createReferenceGame(),
      manifest: REFERENCE_MANIFEST,
      seed: "stall-replay",
      config: REFERENCE_CONFIG,
      scheduler,
      checkpointEvery: 60,
    })
    host.start()
    for (let i = 0; i < 30; i++) scheduler.advance(1000 / 60)
    host.live?.push({ device: "key", code: "thrust", value: 1 })
    scheduler.advance(300_000)
    for (let i = 0; i < 120; i++) scheduler.advance(1000 / 60)
    host.stop()

    const recording = decodeRecording(encodeRecording(host.recording()))
    const replayed = runSession({
      module: createReferenceGame(),
      seed: recording.seed,
      config: recording.config as typeof REFERENCE_CONFIG,
      inputs: new RecordedInputSource(recording.inputs),
      maxTicks: recording.endTick,
      checkpointEvery: 60,
      counters: REFERENCE_MANIFEST.counters,
    })
    expect(replayed.endTick).toBe(recording.endTick)
    for (const checkpoint of recording.checkpoints) {
      const other = replayed.checkpoints.find((c) => c.tick === checkpoint.tick)
      expect(other?.hash, `tick ${checkpoint.tick}`).toBe(checkpoint.hash)
    }
  })
})

describe("recording a live session", () => {
  test("the log replays to the state the host reached", () => {
    const scheduler = new ManualScheduler()
    const host = new GameHost({
      module: createReferenceGame(),
      manifest: REFERENCE_MANIFEST,
      seed: "live",
      config: REFERENCE_CONFIG,
      scheduler,
      checkpointEvery: 60,
    })
    host.start()
    // Press things at wall-clock-uncontrolled moments, the way a player does.
    const presses = ["left", "right", "thrust"]
    for (let frame = 0; frame < 1200 && host.status !== "ended"; frame++) {
      if (frame % 17 === 0) {
        host.live?.push({
          device: "key",
          code: presses[frame % presses.length] as string,
          value: frame % 34 === 0 ? 1 : 0,
        })
      }
      scheduler.advance(frame % 5 === 0 ? 33 : 16)
    }
    host.stop()

    const recording = host.recording()
    // A recording of nothing would pass every assertion below.
    expect(recording.inputs.length).toBeGreaterThan(20)
    expect(recording.endTick).toBeGreaterThan(400)
    expect(recording.checkpoints.length).toBeGreaterThan(6)

    const replayed = runSession({
      module: createReferenceGame(),
      seed: recording.seed,
      config: recording.config as typeof REFERENCE_CONFIG,
      inputs: new RecordedInputSource(recording.inputs),
      maxTicks: recording.endTick,
      checkpointEvery: 60,
      counters: REFERENCE_MANIFEST.counters,
    })
    for (const checkpoint of recording.checkpoints) {
      const other = replayed.checkpoints.find((c) => c.tick === checkpoint.tick)
      expect(other?.hash, `tick ${checkpoint.tick}`).toBe(checkpoint.hash)
    }
    expect(replayed.counters).toEqual(recording.counters)
  })
})

describe("speed", () => {
  test("changes how fast a replay runs and nothing else", () => {
    const log = botLog("speed", 20_000)
    const normal = new ManualScheduler()
    const normalHost = replayHost(log, normal)
    normalHost.start()
    while (normalHost.status !== "ended") normal.advance(1000 / 60)

    const fast = new ManualScheduler()
    const fastHost = replayHost(log, fast)
    fastHost.setSpeed(10)
    fastHost.start()
    while (fastHost.status !== "ended") fast.advance(1000 / 60)

    expect(fastHost.result().checkpoints).toEqual(
      normalHost.result().checkpoints,
    )
    // Ten times the speed, roughly a tenth of the frames.
    expect(fastHost.stats.frames * 5).toBeLessThan(normalHost.stats.frames)
  })

  test("a speed that is not a positive number is refused", () => {
    const host = replayHost([], new ManualScheduler())
    expect(() => host.setSpeed(0)).toThrow(/E_ARG_INVALID/)
    expect(() => host.setSpeed(-1)).toThrow(/E_ARG_INVALID/)
    expect(() => host.setSpeed(Number.NaN)).toThrow(/E_ARG_INVALID/)
  })
})

describe("pause and resume", () => {
  test("a pause does not bank the time it was paused for", () => {
    const scheduler = new ManualScheduler()
    const host = replayHost(botLog("pause", 20_000), scheduler)
    host.start()
    for (let i = 0; i < 30; i++) scheduler.advance(1000 / 60)
    const atPause = host.tick
    host.pause()
    scheduler.advance(600_000) // ten minutes
    expect(host.tick).toBe(atPause)
    host.resume()
    scheduler.advance(1000 / 60)
    expect(host.tick - atPause).toBeLessThanOrEqual(2)
  })
})

/**
 * Stepping by hand, and what the host reports about a run in progress.
 *
 * `stepOnce` exists so a test can run a session with no frame pacing at all.
 * That is only worth having if it reaches the same place the paced loop does,
 * which is the first thing below. The rest are the numbers a host UI and a
 * renderer read every frame: a progress bar built on `tick`, an interpolating
 * renderer built on `alpha`, and a diagnostics panel built on `stats`.
 */
describe("stepping by hand", () => {
  const log = botLog("by-hand", 5_000)

  test("reaches the same state as the paced loop", () => {
    // If it did not, every test that uses it would be checking a second
    // implementation of the loop rather than the one that ships.
    const paced = replayHost(log, new ManualScheduler())
    const pacedScheduler = new ManualScheduler()
    const pacedHost = replayHost(log, pacedScheduler)
    pacedHost.start()
    pacedScheduler.run(400, 1000 / 60)
    void paced

    const stepped = replayHost(log, new ManualScheduler())
    while (stepped.tick < pacedHost.tick && stepped.stepOnce()) {
      // run it out by hand
    }

    expect(stepped.tick).toBe(pacedHost.tick)
    expect(stepped.snapshot()).toEqual(pacedHost.snapshot())
    expect(stepped.counters()).toEqual(pacedHost.counters())
  })

  test("tick advances exactly one per step", () => {
    // A host that counted two would put a progress bar at twice the truth and
    // end a session early.
    const host = replayHost(log, new ManualScheduler())
    const before = host.tick
    host.stepOnce()
    host.stepOnce()
    host.stepOnce()
    expect(host.tick).toBe(before + 3)
  })

  test("the last step ends the session and reports it once", () => {
    const ends: number[] = []
    const host = new GameHost({
      module: createReferenceGame(),
      manifest: REFERENCE_MANIFEST,
      seed: "by-hand-end",
      config: REFERENCE_CONFIG,
      inputs: new RecordedInputSource(log),
      scheduler: new ManualScheduler(),
      checkpointEvery: 60,
      maxTicks: 30,
      onEnded: (result) => ends.push(result.endTick),
    })
    while (host.stepOnce()) {
      // to the end
    }
    expect(host.status).toBe("ended")
    expect(ends.length).toBe(1)
    expect(ends[0]).toBe(host.result().endTick)
  })

  test("stats count the ticks that were actually run", () => {
    const host = replayHost(log, new ManualScheduler())
    for (let i = 0; i < 17; i++) host.stepOnce()
    expect(host.stats.ticksRun).toBe(17)
    // Nothing was paced, so no frame was ever drawn.
    expect(host.stats.frames).toBe(0)
  })
})

describe("what a renderer and a host UI read", () => {
  const log = botLog("readouts", 5_000)

  /**
   * alpha is how far between the last tick and the next this frame sits, and
   * a renderer multiplies it into a position. Outside [0, 1) it would draw the
   * game ahead of or behind a state that was never simulated.
   */
  test("alpha stays inside [0, 1) at every frame rate", () => {
    for (const ms of [1000 / 240, 1000 / 60, 7.3, 200]) {
      const scheduler = new ManualScheduler()
      const host = replayHost(log, scheduler)
      host.start()
      for (let i = 0; i < 60; i++) {
        scheduler.advance(ms)
        expect(host.alpha).toBeGreaterThanOrEqual(0)
        expect(host.alpha).toBeLessThan(1)
      }
    }
  })

  /**
   * The upper end is the one that bites. A tick at 60Hz is 1000/60 ms, which
   * is not representable, so frames of exactly one tick accumulate a residue
   * that creeps towards a whole tick without ever making one: ten of them
   * leave alpha at 0.9999999999999987. A renderer handed 1 would draw the
   * state one tick ahead of the one that was simulated, so the bound has to be
   * strict rather than rounded.
   */
  test("alpha approaches 1 without reaching it", () => {
    const scheduler = new ManualScheduler()
    const host = replayHost(log, scheduler)
    host.start()
    let highest = 0
    for (let i = 0; i < 200; i++) {
      scheduler.advance(1000 / 60)
      highest = Math.max(highest, host.alpha)
      expect(host.alpha).toBeLessThan(1)
    }
    expect(highest).toBeGreaterThan(0.99)
  })

  /**
   * A frame that took far longer than a tick runs several, and the diagnostics
   * panel reports the worst one. A stalled tab that reported one tick per frame
   * would hide exactly the case the catch-up limit exists for.
   */
  test("stats report the worst frame, not the average", () => {
    const scheduler = new ManualScheduler()
    const host = replayHost(log, scheduler)
    host.start()
    scheduler.advance(1000 / 60)
    const afterOne = host.stats.mostTicksInAFrame
    scheduler.advance(1000)
    expect(host.stats.mostTicksInAFrame).toBeGreaterThan(afterOne)
    expect(host.stats.frames).toBe(2)
  })

  test("the manifest and seed it reports are the ones it was built with", () => {
    // The frame bridge hashes this manifest into its `ready` message, so a
    // host reporting a different one would announce a game it is not running.
    const host = replayHost(log, new ManualScheduler())
    expect(host.manifest).toBe(REFERENCE_MANIFEST)
    expect(host.seed).toBe("frame-rate")
  })

  test("snapshot and counters are the module's own, live", () => {
    const host = replayHost(log, new ManualScheduler())
    const atStart = host.snapshot()
    for (let i = 0; i < 40; i++) host.stepOnce()
    expect(host.snapshot()).not.toEqual(atStart)
    expect(host.counters()).toEqual(host.result().counters)
  })
})
