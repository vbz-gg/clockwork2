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
 * `chaosInputs` and `botInputs` press what the game's own manifest binds,
 * with values across each code's range, edges included: a pointer at the
 * viewport's edge, a stick at full deflection, a burst of wheel notches. A
 * game draws its own controls and hit-tests them in `tick`, so a log that
 * pressed fixed key names would never reach the code that reads them.
 * `chaosLog` and `botLog` are the original fixed-name logs, kept because the
 * probe's golden vectors are pinned to them.
 */

import type { InputEvent } from "../contract.js"
import { type CodeSpec, describeCode, maxOf } from "../input-codes.js"
import type { Manifest } from "../manifest/types.js"
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

/** One bound code, as a log generator sees it. */
type Bound = {
  readonly action: string
  readonly code: string
  readonly spec: CodeSpec
}

function boundOf(manifest: Manifest): readonly Bound[] {
  const bound: Bound[] = []
  for (const [action, bindings] of Object.entries(manifest.inputs.map)) {
    for (const binding of bindings) {
      const spec = describeCode(binding.code)
      if (spec !== undefined) bound.push({ action, code: binding.code, spec })
    }
  }
  return bound
}

/** A value `bound` can carry: an edge when `edge`, anything in range otherwise. */
function valueFor(
  rng: Prng,
  bound: Bound,
  manifest: Manifest,
  edge: boolean,
): number {
  const { spec } = bound
  if (spec.kind === "press") return rng.randomBoolean() ? 1 : 0
  const max = maxOf(spec, manifest.inputs.viewport)
  if (spec.kind === "level") {
    return edge
      ? rng.randomChoice([spec.min, max])
      : rng.randomInt(spec.min, max)
  }
  // An impulse is never zero.
  const size = edge ? max : rng.randomInt(1, Math.min(5, max))
  return rng.randomBoolean() ? size : -size
}

function event(tick: number, bound: Bound, value: number): InputEvent {
  return { tick, device: bound.spec.device, code: bound.action, value }
}

/**
 * Random inputs from the game's own bindings at random ticks, a quarter of
 * them at the edge of their range. Not a player; a fuzzer.
 */
export function chaosInputs(
  manifest: Manifest,
  seed: string,
  endTick: number,
): readonly InputEvent[] {
  const bound = boundOf(manifest)
  if (bound.length === 0) return []
  const rng = new Prng(`chaos-inputs:${seed}`)
  const events: InputEvent[] = []
  let tick = 0
  while (tick < endTick) {
    tick += rng.randomInt(1, 20)
    if (tick >= endTick) break
    const pick = rng.randomChoice(bound)
    events.push(
      event(tick, pick, valueFor(rng, pick, manifest, rng.randomBoolean(0.25))),
    )
  }
  return events
}

/**
 * A plausible player of the game's own controls: holds one press for a
 * while and lets go, puts a pointer where it presses before it presses, and
 * moves sticks, tilt and the wheel now and then.
 */
export function botInputs(
  manifest: Manifest,
  seed: string,
  endTick: number,
): readonly InputEvent[] {
  const bound = boundOf(manifest)
  const presses = bound.filter((b) => b.spec.kind === "press")
  const positions = bound.filter(
    (b) => b.spec.kind === "level" && typeof b.spec.max !== "number",
  )
  const levels = bound.filter(
    (b) => b.spec.kind === "level" && typeof b.spec.max === "number",
  )
  const impulses = bound.filter((b) => b.spec.kind === "impulse")
  const rng = new Prng(`bot-inputs:${seed}`)
  const events: InputEvent[] = []
  let holding: Bound | null = null
  let tick = 0
  while (tick < endTick) {
    tick += rng.randomInt(6, 40)
    if (tick >= endTick) break
    if (holding !== null) {
      events.push(event(tick, holding, 0))
      holding = null
    } else if (presses.length > 0) {
      const press = rng.randomChoice(presses)
      // A pointer's own position goes in before its press, as the host
      // records it, so a hit test in `tick` has somewhere to look.
      const pointer = press.code.match(/^pointer(\d)/)
      if (pointer !== null) {
        for (const at of positions) {
          if (at.code.startsWith(`pointer${pointer[1]}-`)) {
            events.push(event(tick, at, valueFor(rng, at, manifest, false)))
          }
        }
      }
      events.push(event(tick, press, 1))
      holding = press
    }
    if (levels.length > 0 && rng.randomBoolean(0.4)) {
      const level = rng.randomChoice(levels)
      events.push(event(tick, level, valueFor(rng, level, manifest, false)))
    }
    if (impulses.length > 0 && rng.randomBoolean(0.2)) {
      const impulse = rng.randomChoice(impulses)
      events.push(event(tick, impulse, valueFor(rng, impulse, manifest, false)))
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
