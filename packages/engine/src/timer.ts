/**
 * Tick timers.
 *
 * Much smaller than Clockwork 1's, because a fixed step removes the reason it
 * was big. There, one `update` could carry a thousand ticks, so the timer had
 * a catch-up loop, a 1,000-iteration guard, and a repeating timer that could
 * fire many times inside a single update. Here a step is one tick, so a timer
 * due this tick fires once, now.
 *
 * Handlers are registered by name rather than passed as closures. That is what
 * makes a timer restorable: a snapshot holds names and tick numbers, which are
 * plain data, and `importState` binds them back to the handlers the game
 * declared during `init`. A closure cannot survive a snapshot, and a timer
 * that cannot survive a snapshot means `restore` silently loses scheduled
 * work.
 */

import type { PlainValue } from "./contract.js"
import { fail } from "./errors.js"

export type TimerHandler = () => void

type Entry = {
  readonly id: number
  readonly name: string
  targetTick: number
  /** 0 for a one-shot. */
  readonly interval: number
  paused: boolean
}

export type TimerEntryState = {
  readonly id: number
  readonly name: string
  readonly targetTick: number
  readonly interval: number
  readonly paused: boolean
}

export type TimerState = {
  readonly tick: number
  readonly nextId: number
  readonly entries: readonly TimerEntryState[]
}

type AssertPlain<T extends PlainValue> = T
export type TimerStateIsPlain = AssertPlain<TimerState>

export class Timer {
  private handlers = new Map<string, TimerHandler>()
  private entries = new Map<number, Entry>()
  private currentTick = 0
  private nextId = 1

  /** The tick most recently run. Starts at 0 and is advanced by the loop. */
  get tick(): number {
    return this.currentTick
  }

  /**
   * Registers a handler. Call these during `init`, before any scheduling, so
   * that a restore into a fresh module finds every name it needs.
   */
  define(name: string, handler: TimerHandler): void {
    this.handlers.set(name, handler)
  }

  /** Runs `name` once, `ticks` from now. */
  after(name: string, ticks: number): number {
    return this.schedule(name, ticks, 0)
  }

  /** Runs `name` every `ticks`, starting `ticks` from now. */
  every(name: string, ticks: number): number {
    if (!Number.isInteger(ticks) || ticks < 1) {
      fail("E_ARG_INVALID", {
        detail: `every() needs a whole number of ticks above 0, got ${ticks}`,
      })
    }
    return this.schedule(name, ticks, ticks)
  }

  private schedule(name: string, ticks: number, interval: number): number {
    if (!this.handlers.has(name)) {
      throw new ReferenceError(`no timer handler named ${JSON.stringify(name)}`)
    }
    if (!Number.isInteger(ticks) || ticks < 0) {
      fail("E_ARG_INVALID", {
        detail: `a delay must be a whole number of ticks, got ${ticks}`,
      })
    }
    const id = this.nextId++
    // A zero delay means the next tick, never this one: firing inside the pass
    // that scheduled it is how a timer loop becomes infinite.
    this.entries.set(id, {
      id,
      name,
      targetTick: this.currentTick + Math.max(ticks, 1),
      interval,
      paused: false,
    })
    return id
  }

  clear(id: number): boolean {
    return this.entries.delete(id)
  }

  pause(id: number): void {
    const entry = this.entries.get(id)
    if (entry !== undefined) entry.paused = true
  }

  resume(id: number): void {
    const entry = this.entries.get(id)
    if (entry !== undefined) entry.paused = false
  }

  get size(): number {
    return this.entries.size
  }

  has(id: number): boolean {
    return this.entries.has(id)
  }

  /**
   * Moves to the next tick and runs whatever is due.
   *
   * Due entries run in `(targetTick, id)` order, so two timers landing on the
   * same tick always run in the order they were created. A handler that
   * schedules another timer does not make it run in this pass, because a
   * delay of zero is treated as one tick.
   */
  advance(): void {
    this.currentTick++
    const due: Entry[] = []
    for (const entry of this.entries.values()) {
      if (!entry.paused && entry.targetTick <= this.currentTick) due.push(entry)
    }
    if (due.length === 0) return
    due.sort((a, b) =>
      a.targetTick === b.targetTick ? a.id - b.id : a.targetTick - b.targetTick,
    )
    for (const entry of due) {
      if (entry.interval > 0) {
        entry.targetTick += entry.interval
      } else {
        this.entries.delete(entry.id)
      }
      const handler = this.handlers.get(entry.name)
      if (handler === undefined) {
        throw new ReferenceError(
          `timer handler ${JSON.stringify(entry.name)} is gone`,
        )
      }
      // Deliberately not wrapped in try/catch. Clockwork 1 logged and
      // swallowed, so a broken timer became a game that quietly did nothing.
      handler()
    }
  }

  /** Everything except the handlers, which the game owns. */
  exportState(): TimerState {
    const entries = [...this.entries.values()]
      .sort((a, b) => a.id - b.id)
      .map((entry) => ({
        id: entry.id,
        name: entry.name,
        targetTick: entry.targetTick,
        interval: entry.interval,
        paused: entry.paused,
      }))
    return { tick: this.currentTick, nextId: this.nextId, entries }
  }

  /** Rebinds a state onto the handlers already declared. */
  importState(state: TimerState): void {
    this.currentTick = state.tick
    this.nextId = state.nextId
    this.entries.clear()
    for (const entry of state.entries) {
      if (!this.handlers.has(entry.name)) {
        fail("E_RESTORE_MISMATCH", {
          detail: `snapshot schedules the timer ${JSON.stringify(entry.name)}, which this module never defined`,
        })
      }
      this.entries.set(entry.id, {
        id: entry.id,
        name: entry.name,
        targetTick: entry.targetTick,
        interval: entry.interval,
        paused: entry.paused,
      })
    }
  }

  /** Drops every scheduled entry, keeping the declared handlers. */
  reset(): void {
    this.entries.clear()
    this.currentTick = 0
    this.nextId = 1
  }
}
