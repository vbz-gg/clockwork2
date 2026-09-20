/**
 * The frozen recordings.
 *
 * This is the test that catches a change to the simulation which silently
 * invalidates every score anybody has already recorded. A record-and-replay
 * test cannot see that: it records and replays against the same build, so a
 * change that moves both stays invisible. These recordings were made on a
 * build that is now history, and they still have to replay to the same place.
 *
 * Regenerating them is a deliberate act - `bun run scripts/mint-fixture.ts` -
 * and the commit body says why.
 */

import { describe, expect, test } from "bun:test"
import { readdirSync, readFileSync } from "node:fs"
import { join } from "node:path"
import {
  decodeRecording,
  RecordedInputSource,
  runSession,
} from "@clockwork2/kernel"
import { createGame, MANIFEST, type SnakeConfig } from "../src/game/index"

const FIXTURES = join(import.meta.dir, "../../e2e/fixtures")

function names(): string[] {
  return readdirSync(FIXTURES)
    .filter((file) => file.endsWith(".json"))
    .map((file) => file.replace(/\.json$/, ""))
    .sort()
}

function replayToText(name: string): string {
  const recording = decodeRecording(
    readFileSync(join(FIXTURES, `${name}.json`), "utf8"),
  )
  const result = runSession({
    module: createGame(),
    seed: recording.seed,
    config: recording.config as unknown as SnakeConfig,
    inputs: new RecordedInputSource(recording.inputs),
    maxTicks: Math.max(recording.endTick, 1),
    checkpointEvery: 60,
    counters: MANIFEST.counters,
  })
  const lines = result.checkpoints.map((c) => `${c.tick}\t${c.hash}`)
  lines.push(`endTick\t${result.endTick}`)
  lines.push(`terminal\t${result.terminal}`)
  for (const counter of Object.keys(result.counters).sort()) {
    lines.push(`${counter}\t${String(result.counters[counter])}`)
  }
  return `${lines.join("\n")}\n`
}

describe("frozen recordings", () => {
  const fixtures = names()

  test("there are some", () => {
    expect(fixtures.length).toBeGreaterThanOrEqual(3)
  })

  for (const name of fixtures) {
    test(`${name} replays to the state it was recorded at`, () => {
      const expected = readFileSync(
        join(FIXTURES, `${name}.checkpoints.txt`),
        "utf8",
      )
      expect(replayToText(name)).toBe(expected)
    })
  }

  test("the recordings are worth replaying", () => {
    // A fixture of four ticks and no inputs would pass every assertion above
    // and prove nothing.
    for (const name of fixtures) {
      const recording = decodeRecording(
        readFileSync(join(FIXTURES, `${name}.json`), "utf8"),
      )
      expect(recording.endTick, name).toBeGreaterThan(600)
      expect(recording.inputs.length, name).toBeGreaterThan(20)
      expect(recording.checkpoints.length, name).toBeGreaterThan(8)
      expect(recording.counters.applesEaten as number, name).toBeGreaterThan(0)
    }
  })

  test("a recording the simulation never produced is refused", () => {
    const recording = JSON.parse(
      readFileSync(join(FIXTURES, `${fixtures[0] as string}.json`), "utf8"),
    ) as Record<string, unknown>
    expect(() => decodeRecording({ ...recording, version: 99 })).toThrow(
      /E_RECORDING_VERSION/,
    )
  })

  test("replaying is a pure function of the recording", () => {
    // Twice in one process, with nothing reset in between.
    const name = fixtures[0] as string
    expect(replayToText(name)).toBe(replayToText(name))
  })
})
