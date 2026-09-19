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
    expect(() => host.setSpeed(0)).toThrow(RangeError)
    expect(() => host.setSpeed(-1)).toThrow(RangeError)
    expect(() => host.setSpeed(Number.NaN)).toThrow(RangeError)
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
