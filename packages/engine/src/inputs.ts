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
 * An input is one the manifest declares, by name, carrying a whole number in
 * its declared range. Each game decides what it records; this module holds
 * the log to what the game declared.
 */

import type { InputEvent } from "./contract.js"
import { fail } from "./errors.js"
import {
  type InputDeclaration,
  type Inputs,
  MAX_SEATS,
} from "./manifest/types.js"

/**
 * The most inputs any single tick may hold. A safety net under the budget
 * below: an honest burst stays far under it.
 */
export const MAX_INPUTS_PER_TICK = 256

/**
 * How many inputs a log may hold per tick it covers, on average. A server
 * holds a whole run to `INPUT_BUDGET_PER_TICK x (endTick + 1)` and each chunk
 * to the same rate over the ticks it covers, so a recording cannot grow
 * without bound however long the run.
 *
 * Four times the busiest honest rate measured, rounded up: two thumbs traced
 * on a pointer declared 0 to 1000 peaked at 3.917 inputs a tick over any
 * 120-tick window. `scripts/measure-inputs.ts` produces the measurement, and
 * the engine guide's `references/inputs.md` has its table and says how each
 * row was made.
 */
export const INPUT_BUDGET_PER_TICK = 16

/** Why `value` is not one `declaration` allows, or null when it is. */
export function outsideDeclaration(
  declaration: InputDeclaration,
  value: number,
): string | null {
  if (!Number.isInteger(value)) return `${String(value)} is not a whole number`
  if (value < declaration.min || value > declaration.max) {
    return `${value} is outside ${declaration.min} to ${declaration.max}`
  }
  return null
}

function declared(inputs: Inputs, code: string): InputDeclaration | undefined {
  return Object.hasOwn(inputs, code) ? inputs[code] : undefined
}

/**
 * The declaration an input's name refers to, or `E_INPUT_UNDECLARED` when
 * the manifest declares no input of that name. `prefix` begins the detail,
 * and `tick` is where the input lands, when that is known.
 */
function declarationOf(
  inputs: Inputs,
  code: string,
  prefix: string,
  tick?: number,
): InputDeclaration {
  const declaration = declared(inputs, code)
  if (declaration === undefined) {
    fail("E_INPUT_UNDECLARED", {
      ...(tick === undefined ? {} : { tick }),
      detail: `${prefix}${JSON.stringify(code)} is not an input the manifest declares`,
    })
  }
  return declaration
}

/**
 * The one check of a single input against the manifest's declarations: a
 * name it declares, carrying a whole number inside that input's range, or
 * `E_INPUT_UNDECLARED`. The live queue runs it where an input is pushed, a
 * `RemoteInputFeed` where one arrives, and `checkInputs` over a whole log,
 * so the three cannot drift apart.
 */
function checkDeclaredInput(
  inputs: Inputs,
  code: string,
  value: number,
  prefix: string,
  tick?: number,
): void {
  const declaration = declarationOf(inputs, code, prefix, tick)
  const outside = outsideDeclaration(declaration, value)
  if (outside !== null) {
    fail("E_INPUT_UNDECLARED", {
      ...(tick === undefined ? {} : { tick }),
      detail: `${prefix}${code}: ${outside}`,
    })
  }
}

/** Where a running simulation gets its inputs, live or recorded. */
export interface InputSource {
  /**
   * Everything that applies to `tick`, in order.
   *
   * `seat` is the seat whose turn `tick` is, from `GameModule.seat()`, and 0
   * in a game with one seat. A source that feeds a single seat, or a log
   * merged from every seat, ignores it.
   */
  take(tick: number, seat: number): readonly InputEvent[]
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
 *
 * A log from before recording version 3 carries a `device` on each input,
 * which is accepted and ignored. A value of `-0` is refused: a recording is
 * JSON, and stored as JSON a `-0` comes back as `0`, so a run replayed from
 * what was submitted and the same run rebuilt from stored chunks would read
 * different values.
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
    if (typeof event.code !== "string" || event.code.length === 0) {
      fail("E_INPUT_RANGE", {
        tick: event.tick,
        detail: `input ${i} has no code`,
      })
    }
    if (!Number.isInteger(event.value) || Object.is(event.value, -0)) {
      fail("E_INPUT_RANGE", {
        tick: event.tick,
        detail: `input ${i} has value ${Object.is(event.value, -0) ? "-0" : String(event.value)}, which is not a whole number a recording keeps`,
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

  private readonly events: readonly InputEvent[]

  constructor(
    events: readonly InputEvent[],
    options: { readonly endTick?: number } = {},
  ) {
    validateInputLog(events, options)
    // Copies of the three fields a simulation reads, so an older
    // recording's `device`, or anything else riding on an input, never
    // reaches `tick`.
    this.events = events.map(({ tick, code, value }) => ({ tick, code, value }))
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
 * How a pending input joins others of the same name before the tick it lands
 * on. `"latest"` keeps only the last value, for a reading that holds (a
 * stick, tilt, a pointer's position): what the tick needs is where it ended
 * up. `"sum"` adds them up, for an amount (wheel notches, mouse movement),
 * and drops a sum of nothing. Left out, every input is kept in order, which a
 * press needs.
 *
 * A merge happens in place, where the first input of that name stands, so a
 * pointer's position recorded before its press stays before it.
 */
export type MergeRule = "latest" | "sum"

/** A device event the host has seen but not yet stamped. */
export interface PendingInput {
  readonly code: string
  readonly value: number
  readonly merge?: MergeRule
}

/** Where the device helpers put what they see: a live queue, or a worker's. */
export interface InputSink {
  push(input: PendingInput): void
  /**
   * Runs `poll` once per frame, before the frame's ticks, for a device the
   * browser does not send events for: a gamepad is read, not heard. Returns
   * a function that stops it.
   */
  addPoller(poll: () => void): () => void
  /**
   * Runs `release` when the session pauses, before the queue stops taking
   * input, so whatever is held is let go in the log. Returns a function that
   * stops it.
   */
  onPause(release: () => void): () => void
  /**
   * Runs `listener` when the session resumes, so a capture that ignored the
   * devices while paused starts hearing them again. Returns a function that
   * stops it.
   */
  onResume(listener: () => void): () => void
}

/**
 * Collects inputs between frames and stamps them at the moment the
 * simulation reaches a tick. The log it builds is the recording.
 *
 * It knows the manifest's inputs and refuses one the manifest does not
 * declare, or a value outside its range, where it is pushed: a misspelt name
 * in a game's page is found while the author plays, not when a server throws
 * the run away.
 */
export class LiveInputQueue implements InputSource, InputSink {
  private pending: PendingInput[] = []
  private readonly log: InputEvent[] = []
  private readonly pollers = new Set<() => void>()
  private readonly pauseListeners = new Set<() => void>()
  private readonly resumeListeners = new Set<() => void>()
  /** What a summed amount owed past its range, carried into later ticks. */
  private readonly carried = new Map<string, number>()
  private pausedNow = false

  constructor(private readonly inputs: Inputs) {}

  push(pushed: PendingInput): void {
    // -0 would be recorded as 0 by JSON and replayed differently.
    const input = Object.is(pushed.value, -0) ? { ...pushed, value: 0 } : pushed
    if (this.pausedNow) return
    const declaration = declarationOf(this.inputs, input.code, "")
    if (!Number.isInteger(input.value)) {
      fail("E_INPUT_RANGE", {
        detail: `input value must be a whole number, got ${String(input.value)}`,
      })
    }
    // A sum may pass its range on the way; it is clamped when it is stamped,
    // and what the clamp leaves over is carried, which ends only at 0.
    if (input.merge === "sum" && (declaration.min > 0 || declaration.max < 0)) {
      fail("E_INPUT_UNDECLARED", {
        detail: `${input.code} is summed, so its range must hold 0, and it is ${declaration.min} to ${declaration.max}`,
      })
    }
    if (input.merge !== "sum") {
      checkDeclaredInput(this.inputs, input.code, input.value, "")
    }
    if (input.merge !== undefined) {
      let at = -1
      for (let i = this.pending.length - 1; i >= 0; i--) {
        const other = this.pending[i] as PendingInput
        if (other.merge === input.merge && other.code === input.code) {
          at = i
          break
        }
      }
      // A level merges where it stands, so a position stays before the press
      // it belongs to. One that moved after a press in the same tick is a new
      // entry after it: merged into the earlier one, the press would read
      // where the pointer ended rather than where it went down.
      const pressedSince =
        input.merge === "latest" &&
        at !== -1 &&
        this.pending.slice(at + 1).some((other) => other.merge === undefined)
      if (at !== -1 && !pressedSince) {
        if (input.merge === "latest") {
          this.pending[at] = input
        } else {
          const total = (this.pending[at] as PendingInput).value + input.value
          if (total === 0) this.pending.splice(at, 1)
          else this.pending[at] = { ...input, value: total }
        }
        return
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

  onPause(release: () => void): () => void {
    this.pauseListeners.add(release)
    return () => {
      this.pauseListeners.delete(release)
    }
  }

  /**
   * The session paused: whatever is held is released, and nothing more is
   * taken until `resume`. A press while paused would land on the tick the
   * session resumes at, which is not when the player made it.
   */
  pause(): void {
    if (this.pausedNow) return
    for (const release of this.pauseListeners) release()
    this.pausedNow = true
  }

  /** Whether the queue is paused, taking no input until `resume`. */
  get paused(): boolean {
    return this.pausedNow
  }

  onResume(listener: () => void): () => void {
    this.resumeListeners.add(listener)
    return () => {
      this.resumeListeners.delete(listener)
    }
  }

  resume(): void {
    if (!this.pausedNow) return
    this.pausedNow = false
    for (const listener of this.resumeListeners) listener()
  }

  /**
   * Stops taking input because another seat's turn begins. It pauses as
   * `pause` does, so the device helpers let go of what they hold, and then
   * drops those releases, everything else pending and any amount carried.
   * A turn's held inputs end with it: the game treats them as released when
   * the acting seat changes, so a release recorded here would land on the
   * other seat's tick. `resume` starts taking input again.
   */
  endTurn(): void {
    this.pause()
    this.pending.length = 0
    this.carried.clear()
  }

  take(tick: number): readonly InputEvent[] {
    this.settleSums()
    if (this.pending.length === 0) return EMPTY
    const stamped: InputEvent[] = []
    for (const input of this.pending) {
      const event: InputEvent = { tick, code: input.code, value: input.value }
      stamped.push(event)
      this.log.push(event)
    }
    this.pending.length = 0
    return stamped
  }

  /**
   * Holds each summed amount to its declared range. The excess is carried
   * into later ticks, up to one range's width, and anything past that is
   * dropped: a flick faster than the game declared it could record is
   * recorded at the most it can carry, never refused.
   */
  private settleSums(): void {
    for (const [code, owed] of this.carried) {
      const at = this.pending.findIndex(
        (other) => other.merge === "sum" && other.code === code,
      )
      if (at === -1) {
        this.pending.unshift({ code, value: owed, merge: "sum" })
      } else {
        const earlier = this.pending[at] as PendingInput
        this.pending[at] = { ...earlier, value: earlier.value + owed }
      }
    }
    this.carried.clear()
    for (let i = this.pending.length - 1; i >= 0; i--) {
      const input = this.pending[i] as PendingInput
      if (input.merge !== "sum") continue
      const declaration = declared(this.inputs, input.code) as InputDeclaration
      const clamped = Math.min(
        declaration.max,
        Math.max(declaration.min, input.value),
      )
      const width = declaration.max - declaration.min
      const excess = Math.min(width, Math.max(-width, input.value - clamped))
      if (excess !== 0) this.carried.set(input.code, excess)
      if (clamped === 0) this.pending.splice(i, 1)
      else this.pending[i] = { ...input, value: clamped }
    }
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
    this.carried.clear()
  }
}

/**
 * Checks a run's whole log against the manifest it was played under: every
 * input is one the manifest declares, with a value in its range; no tick
 * holds more than `MAX_INPUTS_PER_TICK`; and the run holds no more than
 * `INPUT_BUDGET_PER_TICK x (endTick + 1)`.
 *
 * A browser following the manifest records nothing else, but the code in a
 * game's page is the game's, and a log reaches a server from anywhere. This
 * makes "each game decides what is recorded" hold for every log a server
 * ranks. A server runs it against the manifest it stored for the version,
 * never one the game's own code exports. It checks the log's shape first.
 */
export function checkInputs(
  events: readonly InputEvent[],
  inputs: Inputs,
  options: { readonly endTick: number },
): void {
  argumentTick("endTick", options.endTick, 0)
  validateInputLog(events, { endTick: options.endTick })
  checkDeclared(events, inputs)
  checkBudget(events.length, options.endTick + 1)
}

/**
 * The same check for a slice of a log: the inputs after tick `afterTick`
 * through `throughTick`, held to the budget for the ticks they cover. A
 * server runs it on each chunk as it arrives, so a run cannot store more
 * than its budget before it is submitted. `afterTick` is -1 for the first.
 */
export function checkInputSpan(
  events: readonly InputEvent[],
  inputs: Inputs,
  span: { readonly afterTick: number; readonly throughTick: number },
): void {
  argumentTick("afterTick", span.afterTick, -1)
  argumentTick("throughTick", span.throughTick, span.afterTick + 1)
  validateInputLog(events, { endTick: span.throughTick })
  for (const event of events) {
    if (event.tick <= span.afterTick) {
      fail("E_INPUT_RANGE", {
        tick: event.tick,
        detail: `an input at tick ${event.tick} is not after tick ${span.afterTick}`,
      })
    }
  }
  checkDeclared(events, inputs)
  checkBudget(events.length, span.throughTick - span.afterTick)
}

function checkDeclared(events: readonly InputEvent[], inputs: Inputs): void {
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
      fail("E_INPUT_BUDGET", {
        tick,
        detail: `more than ${MAX_INPUTS_PER_TICK} inputs in one tick`,
      })
    }
    checkDeclaredInput(inputs, event.code, event.value, `input ${i}: `, tick)
  }
}

/**
 * A tick the caller passes in, which a wrong one would turn into a quietly
 * wrong budget rather than a refusal: a whole number no lower than `least`.
 */
function argumentTick(name: string, value: number, least: number): void {
  if (!Number.isInteger(value) || value < least) {
    fail("E_ARG_INVALID", {
      detail: `${name} must be a whole number of at least ${least}, got ${String(value)}`,
    })
  }
}

function checkBudget(count: number, ticks: number): void {
  const budget = INPUT_BUDGET_PER_TICK * ticks
  if (count > budget) {
    fail("E_INPUT_BUDGET", {
      detail: `${count} inputs over ${ticks} ticks, past the budget of ${budget}`,
    })
  }
}

/**
 * The inputs of a run several seats take turns in, each seat's from its own
 * source: one `InputSource` per seat, indexed by seat.
 *
 * Each tick it takes from every seat's source, hands the session what the
 * acting seat's source holds, and refuses with `E_INPUT_SEAT` an input any
 * other seat's source holds for that tick, at that tick. A match server
 * replays each seat's own log through it to build the merged log and to
 * trust it: a seat cannot act on another seat's turn, because whose turn a
 * tick is comes from the game's `seat()` and not from the sender. Every
 * source must answer every tick, so a seat's `RemoteInputFeed` has to be
 * confirmed through a tick before the session runs it.
 *
 * `recorded()` is the merged log, everything it handed the session, in
 * order. An input carries no seat, so that log replays through a
 * `RecordedInputSource` like any other.
 */
export class SeatedInputSource implements InputSource {
  private readonly log: InputEvent[] = []

  constructor(private readonly seats: readonly InputSource[]) {
    if (seats.length < 1 || seats.length > MAX_SEATS) {
      fail("E_ARG_INVALID", {
        detail: `a seated source takes one source per seat, 1 to ${MAX_SEATS} of them, and was given ${seats.length}`,
      })
    }
  }

  take(tick: number, seat: number): readonly InputEvent[] {
    if (!Number.isInteger(seat) || seat < 0 || seat >= this.seats.length) {
      fail("E_ARG_INVALID", {
        tick,
        detail: `seat ${String(seat)} has no source here: this source was given ${this.seats.length}, one for each seat the session has`,
      })
    }
    let acting: readonly InputEvent[] = EMPTY
    for (let other = 0; other < this.seats.length; other++) {
      const events = (this.seats[other] as InputSource).take(tick, seat)
      if (other === seat) {
        acting = events
      } else if (events.length > 0) {
        fail("E_INPUT_SEAT", {
          tick,
          detail: `seat ${other} sent ${(events[0] as InputEvent).code} for tick ${tick}, which is seat ${seat}'s turn`,
        })
      }
    }
    for (const event of acting) this.log.push(event)
    return acting
  }

  /** Moves every seat's source past everything before `tick`. */
  seek(tick: number): void {
    for (const source of this.seats) source.seek?.(tick)
  }

  /** The merged log: every input handed to the session, in order. */
  recorded(): readonly InputEvent[] {
    return this.log
  }
}

/**
 * Inputs that arrive over a network, from the page of a seat this page does
 * not play, or from a server relaying a whole run to somebody watching it.
 *
 * `append` adds inputs as they arrive. They come sorted by tick, across one
 * append and the next, each is held to the manifest's declared inputs by the
 * same check the live queue and `checkInputs` run, and none may land on a
 * tick the sender has already confirmed. `confirm(throughTick)` records that
 * the sender has sent everything up to and including that tick.
 *
 * `take(tick)` for a tick past `confirmedThrough` throws
 * `E_INPUT_NOT_CONFIRMED`: inputs for it may still be on their way, so a
 * host holds its loop before that tick rather than running it on a guess. An
 * input for a tick the reader moved past without taking from the feed, which
 * is a tick it ran as a seat the feed does not carry, is `E_INPUT_SEAT` at
 * that input's tick when the reader next takes.
 */
export class RemoteInputFeed implements InputSource {
  private readonly events: InputEvent[] = []
  private cursor = 0
  private confirmed = -1

  /** @param inputs the manifest's declared inputs */
  constructor(private readonly inputs: Inputs) {}

  /**
   * Adds inputs the sender sent. All of them are checked before any is kept,
   * so a refused append leaves the feed as it was.
   *
   * @throws E_INPUT_UNSORTED, E_INPUT_RANGE or E_INPUT_UNDECLARED
   */
  append(events: readonly InputEvent[]): void {
    validateInputLog(events)
    const first = events[0]
    if (first === undefined) return
    if (first.tick <= this.confirmed) {
      fail("E_INPUT_RANGE", {
        tick: first.tick,
        detail: `an input at tick ${first.tick} reaches back to a tick the sender confirmed, through ${this.confirmed}`,
      })
    }
    const last = this.events[this.events.length - 1]
    if (last !== undefined && first.tick < last.tick) {
      fail("E_INPUT_UNSORTED", {
        tick: first.tick,
        detail: `an input at tick ${first.tick} arrived after one at tick ${last.tick}`,
      })
    }
    for (let i = 0; i < events.length; i++) {
      const event = events[i] as InputEvent
      checkDeclaredInput(
        this.inputs,
        event.code,
        event.value,
        `input ${i}: `,
        event.tick,
      )
    }
    for (const { tick, code, value } of events) {
      this.events.push({ tick, code, value })
    }
  }

  /**
   * Records that the sender has sent every input up to and including
   * `throughTick`. Confirming a tick already confirmed changes nothing.
   *
   * @throws E_ARG_INVALID for a tick that is not a whole number, or one
   *   before what was already confirmed
   */
  confirm(throughTick: number): void {
    if (!Number.isInteger(throughTick) || throughTick < this.confirmed) {
      fail("E_ARG_INVALID", {
        detail: `confirm takes a whole number no lower than the tick already confirmed, ${this.confirmed}, got ${String(throughTick)}`,
      })
    }
    this.confirmed = throughTick
  }

  /** The last tick the sender has confirmed, or -1 before the first. */
  get confirmedThrough(): number {
    return this.confirmed
  }

  take(tick: number): readonly InputEvent[] {
    if (tick > this.confirmed) {
      fail("E_INPUT_NOT_CONFIRMED", {
        tick,
        detail: `the feed is confirmed through tick ${this.confirmed}`,
      })
    }
    const next = this.events[this.cursor]
    if (next !== undefined && next.tick < tick) {
      fail("E_INPUT_SEAT", {
        tick: next.tick,
        detail: `the feed holds ${next.code} for tick ${next.tick}, and the reader ran that tick without it, as the turn of a seat the feed does not carry`,
      })
    }
    const start = this.cursor
    while (
      this.cursor < this.events.length &&
      (this.events[this.cursor] as InputEvent).tick === tick
    ) {
      this.cursor++
    }
    return start === this.cursor ? EMPTY : this.events.slice(start, this.cursor)
  }

  /** Skips everything before `tick`, for a session resumed from a snapshot. */
  seek(tick: number): void {
    while (
      this.cursor < this.events.length &&
      (this.events[this.cursor] as InputEvent).tick < tick
    ) {
      this.cursor++
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
