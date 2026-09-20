/**
 * A scripted player for the specs.
 *
 * It reads the view and presses a key, which is what a person does. Pressing
 * at random kills the snake in two seconds and produces a session too short to
 * prove anything; this one plays well enough that the recording is worth
 * replaying.
 *
 * Every press is a real `page.keyboard.press`, so the inputs arrive through
 * the same DOM path a player's do, at times nobody controls. That is the whole
 * point of spec 01.
 */

import type { Checkpoint, Recording } from "@clockwork2/kernel"
import type { Page } from "@playwright/test"

interface View {
  gridSize: number
  segments: Array<{ x: number; y: number }>
  direction: string
  apples: Array<{ x: number; y: number }>
  walls: Array<{ x: number; y: number; horizontal: boolean }>
  bomb: { x: number; y: number } | null
}

const KEY_FOR: Record<string, string> = {
  up: "ArrowUp",
  down: "ArrowDown",
  left: "ArrowLeft",
  right: "ArrowRight",
}
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

function wrap(value: number, size: number): number {
  return (value + size) % size
}

function toroidal(a: number, b: number, size: number): number {
  const direct = Math.abs(a - b)
  return Math.min(direct, size - direct)
}

function choose(view: View): string | null {
  const size = view.gridSize
  const head = view.segments[0]
  if (head === undefined) return null
  const blocked = new Set<string>()
  for (const wall of view.walls) {
    blocked.add(`${wall.x},${wall.y}`)
    const next = wall.horizontal
      ? { x: wrap(wall.x + 1, size), y: wall.y }
      : { x: wall.x, y: wrap(wall.y + 1, size) }
    blocked.add(`${next.x},${next.y}`)
  }
  if (view.bomb !== null) blocked.add(`${view.bomb.x},${view.bomb.y}`)
  for (let i = 0; i < view.segments.length - 1; i++) {
    const segment = view.segments[i] as { x: number; y: number }
    blocked.add(`${segment.x},${segment.y}`)
  }

  /** How many free cells a square has, ignoring the way we came in. */
  function exits(from: { x: number; y: number }, camefrom: string): number {
    let count = 0
    for (const [code, delta] of Object.entries(DELTAS)) {
      if (code === OPPOSITE[camefrom]) continue
      const cell = {
        x: wrap(from.x + delta.x, size),
        y: wrap(from.y + delta.y, size),
      }
      if (!blocked.has(`${cell.x},${cell.y}`)) count++
    }
    return count
  }

  const apple = view.apples[0]
  const options: Array<{ code: string; cost: number }> = []
  for (const [code, delta] of Object.entries(DELTAS)) {
    if (OPPOSITE[code] === view.direction.toLowerCase()) continue
    const next = {
      x: wrap(head.x + delta.x, size),
      y: wrap(head.y + delta.y, size),
    }
    if (blocked.has(`${next.x},${next.y}`)) continue
    const distance =
      apple === undefined
        ? 0
        : toroidal(next.x, apple.x, size) + toroidal(next.y, apple.y, size)
    // One ply of lookahead. Without it the player walks into pockets the
    // walls have closed off and dies in a couple of seconds, which makes the
    // length of a recorded session a matter of luck.
    const deadEnd = exits(next, code) === 0 ? size * 4 : 0
    options.push({ code, cost: distance + deadEnd })
  }
  if (options.length === 0) return null
  options.sort((a, b) => a.cost - b.cost || a.code.localeCompare(b.code))
  const best = options[0] as { code: string }
  return best.code === view.direction.toLowerCase() ? null : best.code
}

/**
 * How long a scripted session plays before the spec stops it.
 *
 * Long enough that the recording is worth replaying, short enough that six
 * specs doing it do not dominate the suite.
 */
export const PLAY_SECONDS = 10

/**
 * The floor a scripted recording has to clear to count as a real session.
 *
 * It is deliberately far below what the player actually produces. The guard's
 * job is to catch a page that silently recorded nothing - which would satisfy
 * every "the replay agrees" assertion in the suite - and not to assert how
 * often a greedy player happens to turn. A tight number here fails on the run
 * where the snake spends longer already pointing the right way, which is a
 * fact about the board and not about determinism.
 */
export const MIN_INPUTS = 4

/**
 * The shortest session that still counts, in ticks.
 *
 * Two seconds, so there are several checkpoints to compare. How long the
 * player survives past that is a property of the board and the walls, not of
 * the replay machinery, and asserting a number closer to the typical run
 * fails on the run where the snake is boxed in early.
 */
export const MIN_TICKS = 120

/**
 * Plays until there is a session worth replaying, and hands it back.
 *
 * A greedy player boxed in by an early wall can die inside two seconds. How
 * long it survives is a property of the board, not of the replay machinery,
 * so a spec that asserts a session length is asserting the wrong thing and
 * will eventually go red on a run that proves nothing.
 *
 * The answer is not to retry the test or to lower the floor until any session
 * passes: it is to play again, on a differently seeded board, until there is a
 * session of the size the spec needs. Every press is still a real key event at
 * a time nobody controls, which is the part that matters.
 */
export async function playSubstantialSession(
  page: Page,
  seed: string,
  attempts = 4,
): Promise<{ recording: Recording; checkpoints: readonly Checkpoint[] }> {
  let shortest = Number.POSITIVE_INFINITY
  for (let attempt = 0; attempt < attempts; attempt++) {
    const thisSeed = attempt === 0 ? seed : `${seed}-${attempt}`
    await page.evaluate((value) => {
      window.__cw2test?.reset(value)
    }, thisSeed)
    await playGreedily(page)
    await page.evaluate(() => {
      window.__cw2test?.stop()
    })
    const session = await page.evaluate(() => ({
      recording: window.__cw2test?.recording(),
      checkpoints: window.__cw2test?.checkpoints() ?? [],
    }))
    const recording = session.recording
    if (recording === undefined) throw new Error("the page recorded nothing")
    if (recording.endTick > MIN_TICKS && recording.inputs.length > MIN_INPUTS) {
      return { recording, checkpoints: session.checkpoints }
    }
    shortest = Math.min(shortest, recording.endTick)
  }
  throw new Error(
    `no session longer than ${MIN_TICKS} ticks in ${attempts} attempts (shortest ${shortest}); the scripted player or the game has changed`,
  )
}

/** Plays for at most `seconds`, or until the run ends. */
export async function playGreedily(
  page: Page,
  seconds: number = PLAY_SECONDS,
): Promise<void> {
  const until = Date.now() + seconds * 1000
  while (Date.now() < until) {
    const state = await page.evaluate(() => ({
      view: window.__cw2test?.view() as unknown,
      running: window.__cw2test?.state().running ?? false,
    }))
    if (!state.running) return
    const turn = choose(state.view as View)
    if (turn !== null) await page.keyboard.press(KEY_FOR[turn] as string)
    await page.waitForTimeout(60)
  }
}

/**
 * Erases a payload's type at the `page.evaluate` boundary.
 *
 * A `Recording` bottoms out in `PlainValue`, which is recursive, and Playwright
 * infers the argument type from the value it is handed. TypeScript gives up on
 * that instantiation (TS2589) rather than on the code. Nothing is lost by
 * erasing it here: the value crosses a structured clone, where a type does not
 * survive anyway, and the function on the other side declares what it wants.
 */
export function payload(value: unknown): Record<string, unknown> {
  return value as Record<string, unknown>
}
