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

  const apple = view.apples[0]
  const options: Array<{ code: string; cost: number }> = []
  for (const [code, delta] of Object.entries(DELTAS)) {
    if (OPPOSITE[code] === view.direction.toLowerCase()) continue
    const next = {
      x: wrap(head.x + delta.x, size),
      y: wrap(head.y + delta.y, size),
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

/** Plays for at most `seconds`, or until the run ends. */
export async function playGreedily(page: Page, seconds: number): Promise<void> {
  const until = Date.now() + seconds * 1000
  while (Date.now() < until) {
    const state = await page.evaluate(() => ({
      view: window.__cw2test?.view() as unknown,
      running: window.__cw2test?.state().running ?? false,
    }))
    if (!state.running) return
    const turn = choose(state.view as View)
    if (turn !== null) await page.keyboard.press(KEY_FOR[turn] as string)
    await page.waitForTimeout(90)
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
