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

import type { InputDevice, InputEvent } from "./contract"
import { INPUT_DEVICES } from "./contract"
import { fail } from "./errors"

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

/** A device event the host has seen but not yet stamped. */
export interface PendingInput {
  readonly device: InputDevice
  readonly code: string
  readonly value: number
}

/**
 * Collects device events between frames and stamps them at the moment the
 * simulation reaches a tick. The log it builds is the recording.
 */
export class LiveInputQueue implements InputSource {
  private pending: PendingInput[] = []
  private readonly log: InputEvent[] = []

  /** Called by the host from a device event handler. */
  push(input: PendingInput): void {
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
    this.pending.push(input)
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
