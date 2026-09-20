/**
 * Mints a frozen recording fixture.
 *
 * These are the highest-value long-lived tests in the repository, because they
 * are the only ones that catch "someone changed the simulation and silently
 * invalidated every score anybody has already recorded". A record-and-replay
 * test cannot see that: it records and replays against the same build, so a
 * change that moves both stays invisible.
 *
 *   bun run scripts/mint-fixture.ts <name> [seed]
 *
 * Writes e2e/fixtures/<name>.json and <name>.checkpoints.txt. Regenerating one
 * is a deliberate act; say why in the commit body.
 */

import { mkdirSync, writeFileSync } from "node:fs"
import { GameHost, ManualScheduler } from "@clockwork2/host-bridge"
import { encodeRecording } from "@clockwork2/kernel"
import {
  createGame,
  DEFAULT_CONFIG,
  MANIFEST,
  type SnakeView,
} from "../demo/src/game/index"

const name = process.argv[2] ?? "snake-01"
const seed = process.argv[3] ?? name

/**
 * A scripted player, good enough to last.
 *
 * It reads the view, which is exactly what a person does, and pushes a
 * direction key. It never touches simulation state. A random turner dies in
 * four seconds and produces a fixture that proves very little; this one plays
 * for long enough that the recording is worth replaying.
 */
const DELTAS: Record<string, { x: number; y: number }> = {
  up: { x: 0, y: -1 },
  down: { x: 0, y: 1 },
  left: { x: -1, y: 0 },
  right: { x: 1, y: 0 },
}
const OPPOSITE: Record<string, string> = {
  up: "down",
  down: "up",
  left: "right",
  right: "left",
}

function wrapped(value: number, size: number): number {
  return (value + size) % size
}

/** Shortest distance on a wrapping grid. */
function toroidal(a: number, b: number, size: number): number {
  const direct = Math.abs(a - b)
  return Math.min(direct, size - direct)
}

function chooseTurn(view: SnakeView): string | null {
  const size = view.gridSize
  const head = view.segments[0]
  if (head === undefined) return null
  const blocked = new Set<string>()
  for (const wall of view.walls) {
    blocked.add(`${wall.x},${wall.y}`)
    const next = wall.horizontal
      ? { x: wrapped(wall.x + 1, size), y: wall.y }
      : { x: wall.x, y: wrapped(wall.y + 1, size) }
    blocked.add(`${next.x},${next.y}`)
  }
  if (view.bomb !== null) blocked.add(`${view.bomb.x},${view.bomb.y}`)
  // The tail moves out of the way this step, so it is not an obstacle.
  for (let i = 0; i < view.segments.length - 1; i++) {
    const segment = view.segments[i] as { x: number; y: number }
    blocked.add(`${segment.x},${segment.y}`)
  }

  const apple = view.apples[0]
  const options: Array<{ code: string; cost: number }> = []
  for (const [code, delta] of Object.entries(DELTAS)) {
    if (OPPOSITE[code] === view.direction.toLowerCase()) continue
    const next = {
      x: wrapped(head.x + delta.x, size),
      y: wrapped(head.y + delta.y, size),
    }
    if (blocked.has(`${next.x},${next.y}`)) continue
    const cost =
      apple === undefined
        ? 0
        : toroidal(next.x, apple.x, size) + toroidal(next.y, apple.y, size)
    options.push({ code, cost })
  }
  if (options.length === 0) return null
  options.sort((a, b) => a.cost - b.cost || a.code.localeCompare(b.code))
  const best = options[0] as { code: string }
  return best.code === view.direction.toLowerCase() ? null : best.code
}

const scheduler = new ManualScheduler()
const module = createGame()
const host = new GameHost({
  module,
  manifest: MANIFEST,
  seed,
  config: DEFAULT_CONFIG,
  scheduler,
  checkpointEvery: 60,
})

host.start()
for (let frame = 0; frame < 60_000 && host.status !== "ended"; frame++) {
  // The snake moves every six ticks, so there is no point deciding faster.
  if (frame % 6 === 0) {
    const turn = chooseTurn(module.view())
    if (turn !== null) host.live?.push({ device: "key", code: turn, value: 1 })
  }
  // A little jitter, because a real display has some.
  scheduler.advance(frame % 7 === 0 ? 20 : 16)
}
if (host.status !== "ended") host.stop()

const recording = host.recording()
const result = host.result()

mkdirSync("e2e/fixtures", { recursive: true })
writeFileSync(`e2e/fixtures/${name}.json`, `${encodeRecording(recording)}\n`)

const lines = result.checkpoints.map((c) => `${c.tick}\t${c.hash}`)
lines.push(`endTick\t${result.endTick}`)
lines.push(`terminal\t${result.terminal}`)
for (const counter of Object.keys(result.counters).sort()) {
  lines.push(`${counter}\t${String(result.counters[counter])}`)
}
writeFileSync(`e2e/fixtures/${name}.checkpoints.txt`, `${lines.join("\n")}\n`)

console.log(
  `e2e/fixtures/${name}.json: ${recording.endTick} ticks, ${recording.inputs.length} inputs, ${result.checkpoints.length} checkpoints, ${String(result.counters.applesEaten)} apples`,
)
