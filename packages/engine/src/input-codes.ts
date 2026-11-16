/**
 * Every device code a manifest may bind, what kind of input it is, and the
 * values it can carry.
 *
 * One table, read by everything that has to agree about an input: the
 * manifest's validator, the host that records inputs in a browser, the check
 * a server runs over a submitted log, and the conformance logs that feed a
 * game nonsense. Before it existed, each of those kept its own idea of what a
 * code was, and a binding such as `pointer0-z` validated, was recorded by
 * nothing, and never fired.
 *
 * Pure data with no DOM, so the simulation side may import it. The code that
 * reads a browser's devices lives in `host/`.
 *
 * Three kinds, because the host treats each differently:
 *
 * - A **press** is 1 while held and 0 when released. A repeat while held is
 *   not an input, and every press the host records it also releases.
 * - A **level** is a position or a reading that holds until it changes: a
 *   pointer coordinate, a stick, tilt. An unchanged value is not an input.
 * - An **impulse** is an amount that happened once: wheel notches, mouse
 *   movement while locked. Two in a row are two inputs, and the host adds up
 *   the impulses of one tick into one.
 */

import type { InputDevice } from "./contract.js"
import { INPUT_DEVICES } from "./contract.js"
import { fail } from "./errors.js"
import { KEY_CODES } from "./key-codes.js"
import type { Inputs } from "./manifest/types.js"

export type CodeKind = "press" | "level" | "impulse"

/** A coordinate's range is the manifest's `inputs.viewport`, on one axis. */
export type ViewportAxis = "width" | "height"

export interface CodeSpec {
  readonly device: InputDevice
  readonly kind: CodeKind
  readonly min: number
  /** A number, or the axis of `inputs.viewport` a coordinate runs across. */
  readonly max: number | ViewportAxis
  /**
   * The value a level goes back to when its device lets go: a stick returns
   * to the centre. A level without one, such as a pointer coordinate or
   * tilt, has no meaningful rest and is left where it was.
   */
  readonly rest?: number
}

export interface Viewport {
  readonly width: number
  readonly height: number
}

/** Fingers, pens and the mouse, each with a small slot number. */
export const POINTER_SLOTS = 10
/** `PointerEvent.button` values: main, middle, right, back, forward. */
export const POINTER_BUTTONS = 5
/** The four controllers a browser reports at most. */
export const GAMEPAD_SLOTS = 4
export const GAMEPAD_BUTTONS = 32
export const GAMEPAD_AXES = 16
/** A stick at full deflection. Small, because every unit a stick passes is an input. */
export const AXIS_UNITS = 100
/** An analog trigger pressed all the way. */
export const TRIGGER_UNITS = 100
/** Full gravity along one of the screen's axes. */
export const TILT_UNITS = 100
/** The most wheel notches one input may carry. */
export const MAX_WHEEL_NOTCHES = 100
/** The most mouse movement one input may carry, in CSS pixels. */
export const MAX_MOUSE_MOVEMENT = 10_000
/**
 * The most inputs a log may hold for one tick. Levels and impulses from a
 * controller, tilt, the wheel and a locked mouse are merged to one input per
 * action per tick, so what can pile up is pointer coordinates, which a
 * browser sends once per animation frame. A 30 Hz game on a 240 Hz display
 * with ten fingers moving gets 8 frames x 10 fingers x 2 coordinates = 160 a
 * tick, plus the presses. A log above this is not a person playing.
 */
export const MAX_INPUTS_PER_TICK = 256

const KEYS = new Set(KEY_CODES)
const PRESS = { kind: "press", min: 0, max: 1 } as const

type Row = {
  readonly pattern: RegExp
  readonly spec: (match: RegExpMatchArray) => CodeSpec
}

/** One digit, or a number up to `limit - 1` with no leading zero. */
function index(limit: number): string {
  const alternatives: string[] = []
  for (let i = 0; i < limit; i++) alternatives.push(String(i))
  return `(${alternatives.join("|")})`
}

const AXIS: Record<string, ViewportAxis> = { x: "width", y: "height" }

/**
 * The code patterns, one row each. A binding's code is looked up here, and a
 * code that matches no row is refused.
 */
export const CODE_ROWS: readonly Row[] = [
  {
    // A finger, a pen, or the mouse with any button down.
    pattern: new RegExp(`^pointer${index(POINTER_SLOTS)}$`),
    spec: () => ({ device: "pointer", ...PRESS }),
  },
  {
    // Where that pointer is while it is down.
    pattern: new RegExp(`^pointer${index(POINTER_SLOTS)}-(x|y)$`),
    spec: (match) => ({
      device: "pointer",
      kind: "level",
      min: 0,
      max: AXIS[match[2] as string] as ViewportAxis,
    }),
  },
  {
    // One mouse or pen button of that pointer, by `PointerEvent.button`.
    pattern: new RegExp(
      `^pointer${index(POINTER_SLOTS)}-button${index(POINTER_BUTTONS)}$`,
    ),
    spec: () => ({ device: "pointer", ...PRESS }),
  },
  {
    // A mouse or pen moving with nothing pressed.
    pattern: /^hover-(x|y)$/,
    spec: (match) => ({
      device: "pointer",
      kind: "level",
      min: 0,
      max: AXIS[match[1] as string] as ViewportAxis,
    }),
  },
  {
    // How far the mouse moved while it is locked to the game.
    pattern: /^mouse-(dx|dy)$/,
    spec: () => ({
      device: "pointer",
      kind: "impulse",
      min: -MAX_MOUSE_MOVEMENT,
      max: MAX_MOUSE_MOVEMENT,
    }),
  },
  {
    pattern: /^wheel-(x|y)$/,
    spec: () => ({
      device: "wheel",
      kind: "impulse",
      min: -MAX_WHEEL_NOTCHES,
      max: MAX_WHEEL_NOTCHES,
    }),
  },
  {
    pattern: new RegExp(
      `^gamepad${index(GAMEPAD_SLOTS)}-button${index(GAMEPAD_BUTTONS)}$`,
    ),
    spec: () => ({ device: "gamepad", ...PRESS }),
  },
  {
    // How far an analog button, such as a trigger, is pressed.
    pattern: new RegExp(
      `^gamepad${index(GAMEPAD_SLOTS)}-button${index(GAMEPAD_BUTTONS)}-value$`,
    ),
    spec: () => ({
      device: "gamepad",
      kind: "level",
      min: 0,
      max: TRIGGER_UNITS,
      rest: 0,
    }),
  },
  {
    pattern: new RegExp(
      `^gamepad${index(GAMEPAD_SLOTS)}-axis${index(GAMEPAD_AXES)}$`,
    ),
    spec: () => ({
      device: "gamepad",
      kind: "level",
      min: -AXIS_UNITS,
      max: AXIS_UNITS,
      rest: 0,
    }),
  },
  {
    // Which way gravity points across the screen: x to the right, y up, z
    // out of the screen. Flat on a table, face up, reads (0, 0, -100).
    pattern: /^tilt-(x|y|z)$/,
    spec: () => ({
      device: "motion",
      kind: "level",
      min: -TILT_UNITS,
      max: TILT_UNITS,
    }),
  },
]

/** What `code` is, or `undefined` when no device produces it. */
export function describeCode(code: string): CodeSpec | undefined {
  if (KEYS.has(code)) return { device: "key", ...PRESS }
  for (const row of CODE_ROWS) {
    const match = code.match(row.pattern)
    if (match !== null) return row.spec(match)
  }
  return undefined
}

/** The largest value `spec` may carry, given the manifest's viewport. */
export function maxOf(spec: CodeSpec, viewport: Viewport | undefined): number {
  if (typeof spec.max === "number") return spec.max
  // The validator refuses a coordinate binding without a viewport, so this
  // is reached only by a caller that skipped it.
  if (viewport === undefined) {
    fail("E_ARG_INVALID", {
      detail: "a pointer coordinate is measured against inputs.viewport",
    })
  }
  return viewport[spec.max]
}

/** True when `value` is one `spec` may carry. */
export function valueFits(
  spec: CodeSpec,
  value: number,
  viewport: Viewport | undefined,
): boolean {
  if (!Number.isInteger(value)) return false
  if (value < spec.min || value > maxOf(spec, viewport)) return false
  // An impulse of nothing is not an input.
  return spec.kind !== "impulse" || value !== 0
}

/**
 * The devices a game's bindings listen to, in `INPUT_DEVICES` order.
 *
 * A page reads this before it starts a run: a game that binds no pointer
 * code cannot be played on a phone with no keyboard, and the place to say so
 * is before the run is spent, not after. It is derived from the bindings
 * rather than declared beside them, so it cannot disagree with them.
 */
export function devicesBound(inputs: Inputs): readonly InputDevice[] {
  const bound = new Set<InputDevice>()
  for (const bindings of Object.values(inputs.map)) {
    for (const binding of bindings) {
      const spec = describeCode(binding.code)
      if (spec !== undefined) bound.add(spec.device)
    }
  }
  return INPUT_DEVICES.filter((device) => bound.has(device))
}
