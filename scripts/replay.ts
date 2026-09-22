#!/usr/bin/env bun
/**
 * Replays a recording headlessly and prints what it reached.
 *
 * The output is one `tick<TAB>hash` line per checkpoint and nothing else, so a
 * disagreement between two runtimes is a readable diff of a handful of lines
 * rather than a wall of JSON.
 *
 *   bun run scripts/replay.ts recording.json
 *   node test-results/replay.mjs recording.json     (after bun run build:replay)
 */

import { readFileSync } from "node:fs"
import {
  decodeRecording,
  RecordedInputSource,
  runSession,
} from "@clockwork2/engine"
import { createGame, MANIFEST, type SnakeConfig } from "../demo/src/game/index"

function main(argv: readonly string[]): number {
  const path = argv[0]
  if (path === undefined) {
    console.error("usage: replay <recording.json>")
    return 2
  }
  const recording = decodeRecording(readFileSync(path, "utf8"))
  if (recording.gameId !== MANIFEST.id) {
    console.error(
      `this recording is for ${recording.gameId}, and this replay knows ${MANIFEST.id}`,
    )
    return 2
  }

  const result = runSession({
    module: createGame(),
    seed: recording.seed,
    config: recording.config as unknown as SnakeConfig,
    inputs: new RecordedInputSource(recording.inputs),
    maxTicks: Math.max(recording.endTick, 1),
    // Where the host checkpointed, which is its manifest's tick rate. A
    // hardcoded 60 agrees with it only for a 60 Hz game; at 30 or 120 the
    // replay would checkpoint at different ticks and every comparison would
    // read as a divergence.
    checkpointEvery: recording.tickHz,
    counters: MANIFEST.counters,
  })

  const lines: string[] = []
  for (const checkpoint of result.checkpoints) {
    lines.push(`${checkpoint.tick}\t${checkpoint.hash}`)
  }
  lines.push(`endTick\t${result.endTick}`)
  lines.push(`terminal\t${result.terminal}`)
  for (const name of Object.keys(result.counters).sort()) {
    lines.push(`${name}\t${String(result.counters[name])}`)
  }
  console.log(lines.join("\n"))
  return 0
}

process.exit(main(process.argv.slice(2)))
