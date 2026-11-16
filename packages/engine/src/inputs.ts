/**
 * The input log, and the two ways a simulation is fed from it.
 *
 * The property that matters is where an input's tick comes from. Clockwork 1
 * stamped an input with the tick of whichever `update` happened to drain the
 * queue, so the same keystroke landed on a different tick depending on the
 * player's frame rate, and the recording was only replayable because it also
 * carried the frame deltas. Here the host stamps an input with the tick the
 * simulation is *about to run*, which is what makes the tick the only timing
 * data a recording needs.
 *
 * Analog sources are quantised to integers before the simulation sees them. A
 * stick reading is a float from a device driver, and floats from a device are
 * not reproducible even on the same machine.
 */

import type { InputDevice, InputEvent } from "./contract.js"
import { INPUT_DEVICES } from "./contract.js"
import { fail } from "./errors.js"
import {
  type CodeSpec,
  describeCode,
  MAX_INPUTS_PER_TICK,
  valueFits,
} from "./input-codes.js"
import type { Inputs } from "./manifest/types.js"

const DEVICES = new Set<string>(INPUT_DEVICES)

/** Where a running simulation gets its inputs, live or recorded. */
export interface InputSource {
  /** Everything that applies to `tick`, in order. */
  take(tick: number): readonly InputEvent[]
  /**
   * Moves past everything before `tick`, for a session resumed from a
   * snapshot. A live source has nothing to skip and may leave this out.
   */
  seek?(tick: number): void
}

const EMPTY: readonly InputEvent[] = Object.freeze([])

/**
 * Checks an input log's shape.
 *
 * Clockwork 1's `validateRecording` checked that deltas were numbers above
 * zero, which let `NaN` and `Infinity` through; they then stalled the replay
 * forever, so every consumer needed a timeout. Nothing here can produce a
 * value that is not a finite integer.
 */
export function validateInputLog(
  events: readonly InputEvent[],
  options: { readonly endTick?: number } = {},
): void {
  let previousTick = -1
  for (let i = 0; i < events.length; i++) {
    const event = events[i] as InputEvent
    if (!Number.isInteger(event.tick) || event.tick < 0) {
      fail("E_INPUT_RANGE", {
        detail: `input ${i} has tick ${String(event.tick)}`,
      })
    }
    if (event.tick < previousTick) {
      fail("E_INPUT_UNSORTED", {
        tick: event.tick,
        detail: `input ${i} goes back from tick ${previousTick}`,
      })
    }
    previousTick = event.tick
    if (!DEVICES.has(event.device)) {
      fail("E_INPUT_RANGE", {
        tick: event.tick,
        detail: `unknown device ${JSON.stringify(event.device)}`,
      })
    }
    if (typeof event.code !== "string" || event.code.length === 0) {
      fail("E_INPUT_RANGE", {
        tick: event.tick,
        detail: `input ${i} has no code`,
      })
    }
    if (!Number.isInteger(event.value)) {
      fail("E_INPUT_RANGE", {
        tick: event.tick,
        detail: `input ${i} has a non-integer value ${String(event.value)}`,
      })
    }
    if (options.endTick !== undefined && event.tick > options.endTick) {
      fail("E_INPUT_RANGE", {
        tick: event.tick,
        detail: `input ${i} is past endTick ${options.endTick}`,
      })
    }
  }
}

/**
 * Replays a recorded log. Built once, then walked with a cursor, so a session
 * costs one pass over the log however many ticks it runs.
 */
export class RecordedInputSource implements InputSource {
  private cursor = 0

  constructor(
    private readonly events: readonly InputEvent[],
    options: { readonly endTick?: number } = {},
  ) {
    validateInputLog(events, options)
  }

  /** Skips everything before `tick`, for a replay that starts part way in. */
  seek(tick: number): void {
    while (
      this.cursor < this.events.length &&
      (this.events[this.cursor] as InputEvent).tick < tick
    ) {
      this.cursor++
    }
  }

  take(tick: number): readonly InputEvent[] {
    if (this.cursor >= this.events.length) return EMPTY
    if ((this.events[this.cursor] as InputEvent).tick !== tick) {
      // Nothing for this tick. A recorded input never arrives late: if the
      // cursor is behind, the caller has skipped a tick, which is a bug.
      if ((this.events[this.cursor] as InputEvent).tick < tick) {
        fail("E_INPUT_UNSORTED", {
          tick,
          detail: `input for tick ${(this.events[this.cursor] as InputEvent).tick} was never taken`,
        })
      }
      return EMPTY
    }
    const start = this.cursor
    while (
      this.cursor < this.events.length &&
      (this.events[this.cursor] as InputEvent).tick === tick
    ) {
      this.cursor++
    }
    return this.events.slice(start, this.cursor)
  }

  /** How far through the log the cursor has walked. */
  get consumed(): number {
    return this.cursor
  }

  get length(): number {
    return this.events.length
  }
}

/**
 * How a pending input joins others of the same device and action before the
 * tick it lands on. `"latest"` keeps only the last, for a reading that holds
 * (a stick, tilt): what the tick needs is where it ended up. `"sum"` adds
 * them, for an amount (wheel notches, mouse movement), and drops a sum of
 * nothing. Left out, every input is kept in order, which a press and a
 * pointer position need: a game hit-testing a touch reads the position
 * before the press in the same tick.
 */
export type MergeRule = "latest" | "sum"

/** A device event the host has seen but not yet stamped. */
export interface PendingInput {
  readonly device: InputDevice
  readonly code: string
  readonly value: number
  readonly merge?: MergeRule
}

/** Where the host's input capture puts what it sees: a live queue, or a worker's. */
export interface InputSink {
  push(input: PendingInput): void
  /**
   * Runs `poll` once per frame, before the frame's ticks, for a device the
   * browser does not send events for: a gamepad is read, not heard. Returns
   * a function that stops it.
   */
  addPoller(poll: () => void): () => void
}

/**
 * Collects device events between frames and stamps them at the moment the
 * simulation reaches a tick. The log it builds is the recording.
 */
export class LiveInputQueue implements InputSource, InputSink {
  private pending: PendingInput[] = []
  private readonly log: InputEvent[] = []
  private readonly pollers = new Set<() => void>()

  /** Called by the host from a device event handler. */
  push(pushed: PendingInput): void {
    // A recording is JSON, which writes -0 as 0, so a live -0 would replay as
    // 0 and a game dividing by it would see -Infinity live and Infinity in
    // the replay. Rounding a small negative reading makes -0 easily.
    const input = Object.is(pushed.value, -0) ? { ...pushed, value: 0 } : pushed
    if (!DEVICES.has(input.device)) {
      fail("E_INPUT_RANGE", {
        detail: `unknown device ${JSON.stringify(input.device)}`,
      })
    }
    if (!Number.isInteger(input.value)) {
      fail("E_INPUT_RANGE", {
        detail: `input value must be an integer, got ${String(input.value)}; quantise analog sources first`,
      })
    }
    if (input.merge !== undefined) {
      const at = this.pending.findIndex(
        (other) =>
          other.merge === input.merge &&
          other.device === input.device &&
          other.code === input.code,
      )
      if (at !== -1) {
        const earlier = this.pending[at] as PendingInput
        this.pending.splice(at, 1)
        if (input.merge === "sum") {
          const total = earlier.value + input.value
          if (total !== 0) this.pending.push({ ...input, value: total })
          return
        }
      }
      if (input.merge === "sum" && input.value === 0) return
    }
    this.pending.push(input)
  }

  addPoller(poll: () => void): () => void {
    this.pollers.add(poll)
    return () => {
      this.pollers.delete(poll)
    }
  }

  /** Reads every polled device. The host calls this before a frame's ticks. */
  poll(): void {
    for (const poll of this.pollers) poll()
  }

  take(tick: number): readonly InputEvent[] {
    if (this.pending.length === 0) return EMPTY
    const stamped: InputEvent[] = []
    for (const input of this.pending) {
      const event: InputEvent = {
        tick,
        device: input.device,
        code: input.code,
        value: input.value,
      }
      stamped.push(event)
      this.log.push(event)
    }
    this.pending.length = 0
    return stamped
  }

  /** The whole log so far, which is what a recording carries. */
  recorded(): readonly InputEvent[] {
    return this.log
  }

  get pendingCount(): number {
    return this.pending.length
  }

  reset(): void {
    this.pending.length = 0
    this.log.length = 0
  }
}

/**
 * Checks a log against the manifest it was played under: every input is one
 * a binding produces, with a value that binding's code can carry, and no
 * tick holds more than `MAX_INPUTS_PER_TICK`. Throws `E_INPUT_UNBOUND` at the
 * first that is not.
 *
 * The browser's host only ever records what the manifest binds, but the
 * code in a game's frame is the game's, and a log reaches a server from
 * anywhere. This is what makes "each game decides what is recorded" hold for
 * every log a server ranks, not only for the honest ones. A server runs it on
 * what it receives, against the manifest it stored for the version, never
 * against one the game's own code exports.
 *
 * It checks the log's shape first (`validateInputLog`), so a caller needs one
 * call.
 */
export function checkInputs(
  events: readonly InputEvent[],
  inputs: Inputs,
): void {
  validateInputLog(events)
  // What each action may receive, per device: the specs of every code bound
  // to it. A recorded event carries the action, not the code, and one
  // action can bind a press and a coordinate of the same device.
  const allowed = new Map<string, CodeSpec[]>()
  for (const [action, bindings] of Object.entries(inputs.map)) {
    for (const binding of bindings) {
      const spec = describeCode(binding.code)
      if (spec === undefined) continue
      const key = `${spec.device}\u0000${action}`
      const specs = allowed.get(key)
      if (specs === undefined) allowed.set(key, [spec])
      else specs.push(spec)
    }
  }
  let tick = -1
  let inTick = 0
  for (let i = 0; i < events.length; i++) {
    const event = events[i] as InputEvent
    if (event.tick !== tick) {
      tick = event.tick
      inTick = 0
    }
    inTick++
    if (inTick > MAX_INPUTS_PER_TICK) {
      fail("E_INPUT_UNBOUND", {
        tick,
        detail: `more than ${MAX_INPUTS_PER_TICK} inputs in one tick`,
      })
    }
    const specs = allowed.get(`${event.device}\u0000${event.code}`)
    if (specs === undefined) {
      fail("E_INPUT_UNBOUND", {
        tick,
        detail: `input ${i}: no ${event.device} code is bound to ${JSON.stringify(event.code)}`,
      })
    }
    if (!specs.some((spec) => valueFits(spec, event.value, inputs.viewport))) {
      fail("E_INPUT_UNBOUND", {
        tick,
        detail: `input ${i}: ${String(event.value)} is not a value the ${event.device} codes bound to ${JSON.stringify(event.code)} carry`,
      })
    }
  }
}

export interface AxisOptions {
  /** Readings inside this fraction of full deflection read as zero. */
  readonly deadzone?: number
  /** Integer units at full deflection. */
  readonly scale?: number
}

const DEFAULT_DEADZONE = 0.08
const DEFAULT_SCALE = 1000

/**
 * Turns a stick or trigger reading in [-1, 1] into an integer.
 *
 * The deadzone is rescaled rather than clipped, so the first unit of movement
 * past it reads as one unit rather than as a jump. A non-finite reading, which
 * a device driver can produce, becomes zero rather than poisoning the log.
 */
export function quantiseAxis(value: number, options: AxisOptions = {}): number {
  const deadzone = options.deadzone ?? DEFAULT_DEADZONE
  const scale = options.scale ?? DEFAULT_SCALE
  if (!Number.isFinite(value)) return 0
  const clamped = value < -1 ? -1 : value > 1 ? 1 : value
  const magnitude = Math.abs(clamped)
  if (magnitude <= deadzone) return 0
  const rescaled = (magnitude - deadzone) / (1 - deadzone)
  const units = Math.round(rescaled * scale)
  return clamped < 0 ? -units : units
}

/**
 * Turns a pointer coordinate into simulation units.
 *
 * The host does this, not the game, so that the simulation never sees a CSS
 * pixel and hit-testing cannot quietly move to the renderer.
 */
export function quantisePoint(
  value: number,
  fromSize: number,
  toUnits: number,
): number {
  if (!Number.isFinite(value) || fromSize <= 0) return 0
  const scaled = Math.round((value / fromSize) * toUnits)
  return scaled < 0 ? 0 : scaled > toUnits ? toUnits : scaled
}
