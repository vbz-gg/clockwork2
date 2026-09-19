/**
 * The three input logs every game is run against.
 *
 * `idle` proves a game ends without help, which is what makes validation cost
 * bounded. `chaos` proves it survives nonsense. `bot` is the platform's own
 * scripted player, and it is the one that matters most: a game that ends under
 * idle but not under a competent player has not really been bounded.
 *
 * They are generated rather than committed, from a seed, so a log is
 * reproducible from two numbers instead of a file.
 */

import type { InputEvent } from "../contract"
import { Prng } from "../prng/index"

export const ACTIONS = ["left", "right", "thrust"] as const

/** Nothing is ever pressed. */
export function idleLog(): readonly InputEvent[] {
  return []
}

/**
 * Random presses and releases at random ticks. Not a player; a fuzzer.
 */
export function chaosLog(seed: string, endTick: number): readonly InputEvent[] {
  const rng = new Prng(`chaos:${seed}`)
  const events: InputEvent[] = []
  let tick = 0
  while (tick < endTick) {
    tick += rng.randomInt(1, 20)
    if (tick >= endTick) break
    events.push({
      tick,
      device: "key",
      code: rng.randomChoice(ACTIONS),
      value: rng.randomBoolean() ? 1 : 0,
    })
  }
  return events
}

/**
 * A plausible player: holds a direction for a while, thrusts in bursts.
 *
 * It is not good at the game, and it does not need to be. What it has to be is
 * *representative*, so that "the run ends inside maxTicks" is tested against
 * something that actually plays rather than against an idle screen.
 */
export function botLog(seed: string, endTick: number): readonly InputEvent[] {
  const rng = new Prng(`bot:${seed}`)
  const events: InputEvent[] = []
  let tick = 0
  let steering: "left" | "right" | null = null
  let thrusting = false

  while (tick < endTick) {
    tick += rng.randomInt(6, 40)
    if (tick >= endTick) break

    if (steering !== null) {
      events.push({ tick, device: "key", code: steering, value: 0 })
      steering = null
    } else {
      steering = rng.randomBoolean() ? "left" : "right"
      events.push({ tick, device: "key", code: steering, value: 1 })
    }

    if (rng.randomBoolean(0.4)) {
      thrusting = !thrusting
      events.push({
        tick,
        device: "key",
        code: "thrust",
        value: thrusting ? 1 : 0,
      })
    }
  }
  return events
}

/** The three, by name, for a runner that sweeps all of them. */
export function standardLogs(
  seed: string,
  endTick: number,
): ReadonlyMap<string, readonly InputEvent[]> {
  return new Map([
    ["idle", idleLog()],
    ["chaos", chaosLog(seed, endTick)],
    ["bot", botLog(seed, endTick)],
  ])
}
