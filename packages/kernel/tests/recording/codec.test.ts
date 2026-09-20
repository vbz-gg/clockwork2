import { describe, expect, test } from "bun:test"
import { RecordedInputSource } from "../../src/inputs"
import { runSession } from "../../src/loop"
import {
  compareToRecording,
  decodeRecording,
  encodeRecording,
  RECORDING_FORMAT,
  RECORDING_VERSION,
  type Recording,
} from "../../src/recording/index"
import { botLog } from "../../src/testing/input-logs"
import {
  createReferenceGame,
  REFERENCE_CONFIG,
  REFERENCE_COUNTERS,
  REFERENCE_MANIFEST,
} from "../../src/testing/reference-game"

function record(seed = "seed-1"): Recording {
  const log = botLog("codec", 20_000)
  const result = runSession({
    module: createReferenceGame(),
    seed,
    config: REFERENCE_CONFIG,
    inputs: new RecordedInputSource(log),
    maxTicks: 18_000,
    checkpointEvery: 60,
    counters: REFERENCE_COUNTERS,
  })
  return {
    format: RECORDING_FORMAT,
    version: RECORDING_VERSION,
    kernelVersion: "0.1.0",
    gameId: REFERENCE_MANIFEST.id,
    gameVersion: REFERENCE_MANIFEST.version,
    manifestHash: "0123456789abcdef",
    tickHz: 60,
    seed,
    config: REFERENCE_CONFIG,
    inputs: log.filter((e) => e.tick <= result.endTick),
    checkpoints: result.checkpoints,
    endTick: result.endTick,
    terminal: result.terminal,
    counters: result.counters,
  }
}

describe("recording codec", () => {
  test("round trips", () => {
    const recording = record()
    expect(decodeRecording(encodeRecording(recording))).toEqual(recording)
  })

  test("decodes an already-parsed object too", () => {
    const recording = record()
    expect(decodeRecording(JSON.parse(encodeRecording(recording)))).toEqual(
      recording,
    )
  })

  test("carries no per-frame delta array", () => {
    // Clockwork 1's recording had one entry per frame, about 18,000 for five
    // minutes, and those deltas were the timing data, so the client decided
    // how much simulation ran.
    const recording = record()
    expect("deltaTicks" in recording).toBe(false)
    const encoded = encodeRecording(recording)
    expect(encoded).not.toContain("deltaTicks")
    // And the whole thing is small enough not to need compressing.
    expect(encoded.length).toBeLessThan(200_000)
  })

  describe("refusals", () => {
    test("a version this kernel does not read", () => {
      // game-base wrote a version field and read it nowhere, while changing
      // codec twice underneath it.
      const recording = { ...record(), version: 99 }
      expect(() => decodeRecording(recording)).toThrow(/E_RECORDING_VERSION/)
    })

    test("a format this kernel does not read", () => {
      expect(() => decodeRecording({ ...record(), format: "cw1" })).toThrow(
        /E_RECORDING_VERSION/,
      )
    })

    test("text that is not JSON", () => {
      expect(() => decodeRecording("{oh no")).toThrow(/E_RECORDING_MALFORMED/)
    })

    test("a missing or wrong field", () => {
      const base = record()
      const cases: Array<[string, Partial<Recording>]> = [
        ["seed", { seed: "" }],
        ["tickHz", { tickHz: 45 as never }],
        ["endTick", { endTick: -1 }],
        ["terminal", { terminal: "exploded" as never }],
        ["counters", { counters: undefined as never }],
      ]
      for (const [label, patch] of cases) {
        expect(() => decodeRecording({ ...base, ...patch }), label).toThrow(
          /E_RECORDING_MALFORMED/,
        )
      }
    })

    test("an input log that is out of order", () => {
      const base = record()
      const inputs = [...base.inputs].reverse()
      expect(() => decodeRecording({ ...base, inputs })).toThrow(
        /E_INPUT_UNSORTED/,
      )
    })

    test("a checkpoint past the end of the run", () => {
      const base = record()
      expect(() =>
        decodeRecording({
          ...base,
          checkpoints: [
            ...base.checkpoints,
            { tick: base.endTick + 1, hash: "a".repeat(16) },
          ],
        }),
      ).toThrow(/E_RECORDING_MALFORMED/)
    })

    test("a checkpoint hash that is not a digest", () => {
      const base = record()
      expect(() =>
        decodeRecording({ ...base, checkpoints: [{ tick: 0, hash: "nope" }] }),
      ).toThrow(/E_RECORDING_MALFORMED/)
    })

    test("a counter that is not a whole number", () => {
      const base = record()
      expect(() =>
        decodeRecording({
          ...base,
          counters: { ...base.counters, score: 1.5 },
        }),
      ).toThrow(/E_RECORDING_MALFORMED/)
    })
  })
})

describe("replaying a recording", () => {
  function replay(recording: Recording) {
    return runSession({
      module: createReferenceGame(),
      seed: recording.seed,
      config: recording.config as typeof REFERENCE_CONFIG,
      inputs: new RecordedInputSource(recording.inputs, {
        endTick: recording.endTick,
      }),
      maxTicks: 18_000,
      checkpointEvery: 60,
      counters: REFERENCE_COUNTERS,
    })
  }

  test("a replay reproduces the recording exactly", () => {
    const recording = decodeRecording(encodeRecording(record()))
    const comparison = compareToRecording(recording, replay(recording))
    expect(comparison.differences).toEqual([])
    expect(comparison.matches).toBe(true)
    expect(comparison.divergedAt).toBeNull()
  })

  test("a tampered counter is caught, and the run itself still matches", () => {
    // This is the check Clockwork 1's platform never made: it overwrote the
    // client's score with the replayed one instead of comparing them, so a
    // divergent run was paid and ranked.
    const recording = record()
    const tampered: Recording = {
      ...recording,
      counters: { ...recording.counters, score: 999_999 },
    }
    const comparison = compareToRecording(tampered, replay(tampered))
    expect(comparison.matches).toBe(false)
    expect(comparison.differences.some((d) => d.startsWith("score:"))).toBe(
      true,
    )
    expect(comparison.divergedAt).toBeNull()
  })

  test("a tampered checkpoint names the second it happened", () => {
    const recording = record()
    const middle = Math.floor(recording.checkpoints.length / 2)
    const checkpoints = recording.checkpoints.map((c, i) =>
      i === middle ? { ...c, hash: "f".repeat(16) } : c,
    )
    const comparison = compareToRecording(
      { ...recording, checkpoints },
      replay(recording),
    )
    expect(comparison.matches).toBe(false)
    expect(comparison.divergedAt).toBe(
      recording.checkpoints[middle]?.tick as number,
    )
  })

  test("a different seed diverges at the first checkpoint that can show it", () => {
    const recording = record("seed-1")
    const other = runSession({
      module: createReferenceGame(),
      seed: "seed-2",
      config: REFERENCE_CONFIG,
      inputs: new RecordedInputSource(recording.inputs, {
        endTick: recording.endTick,
      }),
      maxTicks: 18_000,
      checkpointEvery: 60,
      counters: REFERENCE_COUNTERS,
    })
    const comparison = compareToRecording(recording, other)
    expect(comparison.matches).toBe(false)
    expect(comparison.divergedAt).not.toBeNull()
  })
})
