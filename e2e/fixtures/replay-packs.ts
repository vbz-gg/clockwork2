/**
 * The server's half of the pack game's end-to-end test: replay a run the
 * browser recorded, with every pack read from the fixture's own directory.
 *
 *   bun e2e/fixtures/replay-packs.ts <file>
 *
 * The file is a recording, or the worker page's result, which carries the
 * same fields. It prints the replay's end tick, counters, checkpoints and the
 * tick the game first read its demand pack, as JSON.
 */

import { readFileSync } from "node:fs"
import { join } from "node:path"
import {
  type InputEvent,
  PackSet,
  type PlainValue,
  RecordedInputSource,
  runSession,
} from "@clockwork2/engine"
import { readPacks } from "@clockwork2/engine/validate"
import createGame, {
  MANIFEST,
} from "../../packages/engine/fixtures/packs/index"

const file = process.argv[2]
if (file === undefined) throw new Error("usage: replay-packs.ts <file>")
const run = JSON.parse(readFileSync(file, "utf8")) as {
  seed: string
  config: PlainValue
  inputs: InputEvent[]
  endTick: number
}
const root = join(import.meta.dir, "../../packages/engine/fixtures/packs")
const game = createGame()
const result = runSession({
  module: game,
  seed: run.seed,
  config: run.config,
  inputs: new RecordedInputSource(run.inputs),
  // An ended-early run replays to where the player stopped, not past it.
  maxTicks: Math.min(Math.max(run.endTick, 1), MANIFEST.session.maxTicks),
  checkpointEvery: 60,
  counters: MANIFEST.counters,
  assets: MANIFEST.assets ?? [],
  packs: PackSet.verify(MANIFEST.assets, readPacks(root, MANIFEST)),
})
console.log(
  JSON.stringify({
    endTick: result.endTick,
    counters: result.counters,
    checkpoints: result.checkpoints,
    openedAt: game.view().openedAt,
  }),
)
