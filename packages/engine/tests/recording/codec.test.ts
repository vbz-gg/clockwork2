import { describe, expect, test } from "bun:test"
import { RecordedInputSource } from "../../src/inputs"
import { runSession } from "../../src/loop"
import {
  compareToRecording,
  decodeRecording,
  diffSnapshots,
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
    hostStats: {
      frames: 1200,
      ticksRun: result.endTick,
      mostTicksInAFrame: 5,
      droppedMs: 0,
    },
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

describe("checkpoints a recording may not carry", () => {
  /**
   * The checkpoint list is what a validator compares a replay against, so a
   * malformed one is not a cosmetic problem: a recording whose checkpoints go
   * backwards, or carry a tick that is not a tick, cannot be compared to
   * anything. Rejecting it at the door beats producing a divergence report
   * about a run that was never coherent.
   */
  const CASES: Array<[name: string, checkpoint: unknown]> = [
    ["not an object", "600:deadbeefdeadbeef"],
    ["a tick that is not a whole number", { tick: 1.5, hash: "a".repeat(16) }],
    ["a negative tick", { tick: -1, hash: "a".repeat(16) }],
    [
      "a tick that is not a number at all",
      { tick: "600", hash: "a".repeat(16) },
    ],
    ["a hash that is not sixteen hex digits", { tick: 60, hash: "nope" }],
    ["a hash in capitals", { tick: 60, hash: "A".repeat(16) }],
    ["a hash that is not a string", { tick: 60, hash: 12345 }],
  ]

  for (const [name, checkpoint] of CASES) {
    test(name, () => {
      const recording = { ...record(), checkpoints: [checkpoint] }
      expect(() => decodeRecording(recording)).toThrow(/E_RECORDING_MALFORMED/)
    })
  }

  test("checkpoints that go backwards", () => {
    const recording = {
      ...record(),
      checkpoints: [
        { tick: 60, hash: "a".repeat(16) },
        { tick: 120, hash: "b".repeat(16) },
        { tick: 90, hash: "c".repeat(16) },
      ],
    }
    expect(() => decodeRecording(recording)).toThrow(/E_RECORDING_MALFORMED/)
  })

  test("two checkpoints at one tick are allowed, because a resume makes one", () => {
    // A run resumed from a snapshot writes a checkpoint at the tick it resumed
    // from, beside the one the uninterrupted run already wrote there.
    const recording = {
      ...record(),
      checkpoints: [
        { tick: 60, hash: "a".repeat(16) },
        { tick: 60, hash: "a".repeat(16) },
        { tick: 120, hash: "b".repeat(16) },
      ],
      endTick: 120,
      inputs: [],
    }
    expect(() => decodeRecording(recording)).not.toThrow()
  })
})

describe("comparing a replay to its recording", () => {
  /**
   * An end tick that does not match is its own difference, reported on its own
   * terms. AGENTS.md is explicit about why: if the host loop drops time, the
   * recording must end at the tick the host actually reached, or the log
   * replays to a different state. "ended at 1200, recorded 1800" says that;
   * a list of mismatched checkpoint hashes does not.
   */
  test("an end tick that does not match is reported as itself", () => {
    const recording = record()
    const comparison = compareToRecording(recording, {
      endTick: recording.endTick - 60,
      counters: recording.counters,
      checkpoints: recording.checkpoints,
    })
    expect(comparison.matches).toBe(false)
    expect(comparison.differences.some((d) => d.startsWith("endTick:"))).toBe(
      true,
    )
  })

  test("a counter that does not match names the counter", () => {
    const recording = record()
    const name = Object.keys(recording.counters)[0] as string
    const comparison = compareToRecording(recording, {
      endTick: recording.endTick,
      counters: { ...recording.counters, [name]: -999 },
      checkpoints: recording.checkpoints,
    })
    expect(comparison.matches).toBe(false)
    expect(comparison.differences.some((d) => d.startsWith(`${name}:`))).toBe(
      true,
    )
  })

  test("a counter only one side has is still a difference", () => {
    // A replay that stopped reporting a counter would otherwise compare equal
    // on every counter it did report.
    const recording = record()
    const comparison = compareToRecording(recording, {
      endTick: recording.endTick,
      counters: { ...recording.counters, invented: 1 },
      checkpoints: recording.checkpoints,
    })
    expect(comparison.matches).toBe(false)
    expect(comparison.differences.some((d) => d.startsWith("invented:"))).toBe(
      true,
    )
  })

  test("a matching replay reports no difference and no divergence tick", () => {
    const recording = record()
    const comparison = compareToRecording(recording, {
      endTick: recording.endTick,
      counters: recording.counters,
      checkpoints: recording.checkpoints,
    })
    expect(comparison).toEqual({
      matches: true,
      divergedAt: null,
      differences: [],
    })
  })

  test("the first differing checkpoint is the one reported as the divergence", () => {
    const recording = record()
    const replayed = recording.checkpoints.map((c, i) =>
      i >= 2 ? { ...c, hash: "f".repeat(16) } : c,
    )
    const comparison = compareToRecording(recording, {
      endTick: recording.endTick,
      counters: recording.counters,
      checkpoints: replayed,
    })
    expect(comparison.divergedAt).toBe(recording.checkpoints[2]?.tick ?? -1)
  })
})

describe("diffSnapshots", () => {
  /**
   * What a validator prints when two snapshots part company, so a wrong diff is
   * a wrong bug report. Worth knowing as much for its limit as its behaviour:
   * it compares with JSON.stringify, so it reports key order as a difference
   * that is not one. testing/compare.ts's compareSnapshots uses encodeCanonical
   * and does not. A caller who reaches for the wrong one gets false
   * divergences on a run that never diverged.
   */
  test("a key whose value differs", () => {
    expect(diffSnapshots({ x: 1, y: 2 }, { x: 1, y: 3 })).toEqual([
      "y: expected 2, got 3",
    ])
  })

  test("a key only the actual snapshot has", () => {
    expect(diffSnapshots({ x: 1 }, { x: 1, extra: 9 })).toEqual([
      "extra: only in the actual snapshot",
    ])
  })

  test("a key missing from the actual snapshot", () => {
    expect(diffSnapshots({ x: 1, gone: 2 }, { x: 1 })).toEqual([
      "gone: missing from the actual snapshot",
    ])
  })

  test("identical snapshots have no differences", () => {
    expect(diffSnapshots({ x: 1, y: [1, 2] }, { x: 1, y: [1, 2] })).toEqual([])
  })

  test("differences come out in a stable order", () => {
    // Two runs of a validator have to print the same report, or a diff of the
    // reports is noise.
    expect(
      diffSnapshots({ b: 1, a: 1, c: 1 }, { c: 2, a: 2, b: 2 }).map((d) =>
        d.slice(0, 1),
      ),
    ).toEqual(["a", "b", "c"])
  })

  test("nested values are compared whole, not field by field", () => {
    expect(diffSnapshots({ p: { x: 1 } }, { p: { x: 2 } })).toEqual([
      'p: expected {"x":1}, got {"x":2}',
    ])
  })

  test("and key order inside a nested value reads as a difference", () => {
    // Not a bug, a limit, and the reason compareSnapshots exists beside it.
    expect(diffSnapshots({ p: { x: 1, y: 2 } }, { p: { y: 2, x: 1 } })).toEqual(
      ['p: expected {"x":1,"y":2}, got {"y":2,"x":1}'],
    )
  })
})

describe("reading an older recording", () => {
  /**
   * A recording is evidence about a run that already happened. Refusing to
   * read one because the kernel has moved on throws the evidence away rather
   * than protecting anything, and the three frozen fixtures in e2e/ are
   * version 1.
   */
  test("a version 1 recording decodes, with no host stats", () => {
    const { hostStats: _dropped, ...older } = record()
    const decoded = decodeRecording(JSON.stringify({ ...older, version: 1 }))
    expect(decoded.version).toBe(1)
    expect(decoded.hostStats).toBeNull()
  })

  test("a version this kernel has never heard of is refused", () => {
    const thrown = expectThrows(() =>
      decodeRecording(JSON.stringify({ ...record(), version: 99 })),
    )
    expect(thrown.code).toBe("E_RECORDING_VERSION")
    expect(thrown.detail).toContain("1 and 2")
  })
})

describe("host stats", () => {
  /**
   * A platform reads these to tell a player on a slow phone from a player who
   * is cheating, and those need different answers. A string where a count
   * belongs would make that judgement silently.
   */
  test.each([
    ["not an object", "fast"],
    [
      "a string count",
      { frames: "many", ticksRun: 1, mostTicksInAFrame: 1, droppedMs: 0 },
    ],
    [
      "a fractional count",
      { frames: 1.5, ticksRun: 1, mostTicksInAFrame: 1, droppedMs: 0 },
    ],
    [
      "a negative count",
      { frames: -1, ticksRun: 1, mostTicksInAFrame: 1, droppedMs: 0 },
    ],
    ["a missing key", { frames: 1, ticksRun: 1, mostTicksInAFrame: 1 }],
  ])("refuses %s", (_name, hostStats) => {
    const thrown = expectThrows(() =>
      decodeRecording(JSON.stringify({ ...record(), hostStats })),
    )
    expect(thrown.code).toBe("E_RECORDING_MALFORMED")
  })

  test("keeps a fractional dropped time, which is what a stalled tab reports", () => {
    // The accumulator drops a fraction of a millisecond at a time and this is
    // their sum. Requiring an integer here refused a real recording.
    const stats = {
      frames: 30,
      ticksRun: 120,
      mostTicksInAFrame: 5,
      droppedMs: 299916.6666666667,
    }
    const decoded = decodeRecording(
      JSON.stringify({ ...record(), hostStats: stats }),
    )
    expect(decoded.hostStats?.droppedMs).toBe(299916.6666666667)
  })

  test("survives a round trip", () => {
    const recording = record()
    expect(decodeRecording(encodeRecording(recording)).hostStats).toEqual(
      recording.hostStats,
    )
  })
})

/** The error, with its code, rather than whatever `toThrow` matched. */
function expectThrows(run: () => unknown): { code: string; detail?: string } {
  try {
    run()
  } catch (error) {
    return error as { code: string; detail?: string }
  }
  throw new Error("expected a throw, got none")
}
