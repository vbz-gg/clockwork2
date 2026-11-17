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
 *
 * `chaosInputs` and `botInputs` feed the game's own declared inputs, with
 * values across each input's range, edges included. A game declares its own
 * inputs and decides in `tick` what they mean, so a log that pressed fixed
 * names would never reach the code that reads them. `chaosLog` and `botLog`
 * are the original fixed-name logs, kept only for the probe, whose golden
 * vectors are pinned to them.
 */

import type { InputEvent } from "../contract.js"
import type { InputDeclaration, Manifest } from "../manifest/types.js"
import { Prng } from "../prng/index.js"

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
      events.push({ tick, code: steering, value: 0 })
      steering = null
    } else {
      steering = rng.randomBoolean() ? "left" : "right"
      events.push({ tick, code: steering, value: 1 })
    }

    if (rng.randomBoolean(0.4)) {
      thrusting = !thrusting
      events.push({
        tick,
        code: "thrust",
        value: thrusting ? 1 : 0,
      })
    }
  }
  return events
}

/** One declared input, as a log generator sees it. */
type Declared = {
  readonly name: string
  readonly declaration: InputDeclaration
}

function declaredOf(manifest: Manifest): readonly Declared[] {
  return Object.entries(manifest.inputs).map(([name, declaration]) => ({
    name,
    declaration,
  }))
}

/** A 0-to-1 input reads as a press: held for a while, then let go. */
function isPress({ declaration }: Declared): boolean {
  return declaration.min === 0 && declaration.max === 1
}

/** A value `input` can carry: an edge when `edge`, anywhere in range otherwise. */
function valueFor(rng: Prng, input: Declared, edge: boolean): number {
  const { min, max } = input.declaration
  return edge ? rng.randomChoice([min, max]) : rng.randomInt(min, max)
}

/**
 * Random values of the game's own inputs at random ticks, a quarter of them
 * at the edge of their range. Not a player; a fuzzer.
 */
export function chaosInputs(
  manifest: Manifest,
  seed: string,
  endTick: number,
): readonly InputEvent[] {
  const inputs = declaredOf(manifest)
  if (inputs.length === 0) return []
  const rng = new Prng(`chaos-inputs:${seed}`)
  const events: InputEvent[] = []
  let tick = 0
  while (tick < endTick) {
    tick += rng.randomInt(1, 20)
    if (tick >= endTick) break
    const input = rng.randomChoice(inputs)
    events.push({
      tick,
      code: input.name,
      value: valueFor(rng, input, rng.randomBoolean(0.25)),
    })
  }
  return events
}

/**
 * Someone working the game's own inputs: a press held for a while and let
 * go, and every other input moved across its range now and then, edges
 * included. Representative rather than good, so "the run ends inside
 * maxTicks" is tested against something that keeps playing.
 */
export function botInputs(
  manifest: Manifest,
  seed: string,
  endTick: number,
): readonly InputEvent[] {
  const inputs = declaredOf(manifest)
  const presses = inputs.filter(isPress)
  const others = inputs.filter((input) => !isPress(input))
  const rng = new Prng(`bot-inputs:${seed}`)
  const events: InputEvent[] = []
  let holding: Declared | null = null
  let tick = 0
  while (tick < endTick) {
    tick += rng.randomInt(6, 40)
    if (tick >= endTick) break
    // Other inputs first, so a position lands before the press it goes with.
    if (others.length > 0 && rng.randomBoolean(0.6)) {
      const input = rng.randomChoice(others)
      events.push({
        tick,
        code: input.name,
        value: valueFor(rng, input, rng.randomBoolean(0.2)),
      })
    }
    if (holding !== null) {
      events.push({ tick, code: holding.name, value: 0 })
      holding = null
    } else if (presses.length > 0) {
      holding = rng.randomChoice(presses)
      events.push({ tick, code: holding.name, value: 1 })
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
