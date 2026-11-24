/**
 * What the seat tests share: a two-seat match played by a script, the
 * network between pages, a page's player, and a match server.
 *
 * The game is `fixtures/seats`: each turn the acting seat aims and shoots,
 * the shot rolls, and the turn passes when it stops.
 */

import createTurnsGame, { MANIFEST } from "../../fixtures/seats/index"
import {
  type InputEvent,
  type InputSource,
  RecordedInputSource,
  RemoteInputFeed,
  runSession,
  SeatedInputSource,
  Session,
  type SessionResult,
} from "../../src"
import type { GameHost } from "../../src/host/index"

export { createTurnsGame, MANIFEST }

export const CHECKPOINT_EVERY = 60

/**
 * Two players as a source that knows whose turn it is: each turn, the
 * acting seat aims five ticks in, presses `shoot` a few ticks later and lets
 * go at tick 30 of the turn if the turn is still going. It keeps what each
 * seat pressed, and the seat of every tick it was asked for.
 */
export class ScriptedPlayers implements InputSource {
  readonly shares: InputEvent[][] = [[], []]
  readonly merged: InputEvent[] = []
  /** The seat each tick was asked for, by tick. */
  readonly seats: number[] = []
  private turnStart = 0
  private turns = 0
  private last = -1

  take(tick: number, seat: number): readonly InputEvent[] {
    if (seat !== this.last) {
      this.last = seat
      this.turnStart = tick
      this.turns++
    }
    this.seats[tick] = seat
    const into = tick - this.turnStart
    const events: InputEvent[] = []
    if (into === 5) {
      events.push({ tick, code: "aim", value: (this.turns * 7 + seat) % 32 })
    }
    if (into === 9 + seat * 3) events.push({ tick, code: "shoot", value: 1 })
    if (into === 30) events.push({ tick, code: "shoot", value: 0 })
    for (const event of events) {
      this.shares[seat]?.push(event)
      this.merged.push(event)
    }
    return events
  }
}

/** The ticks on which the seat changed, from the seat of every tick. */
export function turnChanges(seats: readonly number[]): number[] {
  const changes: number[] = []
  for (let tick = 1; tick < seats.length; tick++) {
    if (seats[tick] !== seats[tick - 1]) changes.push(tick)
  }
  return changes
}

/** A whole match, played by the script with every input in hand. */
export function playScripted(seed: string): {
  readonly players: ScriptedPlayers
  readonly result: SessionResult
} {
  const players = new ScriptedPlayers()
  const result = runSession({
    module: createTurnsGame(),
    seed,
    config: {},
    inputs: players,
    maxTicks: 100_000,
    checkpointEvery: CHECKPOINT_EVERY,
    counters: MANIFEST.counters,
    seats: 2,
  })
  return { players, result }
}

/** The seat of every tick a merged log's run reads, found by replaying it. */
export function seatsOfRun(
  seed: string,
  inputs: readonly InputEvent[],
  endTick: number,
): number[] {
  const seats: number[] = []
  const session = new Session({
    module: createTurnsGame(),
    seed,
    config: {},
    inputs: new RecordedInputSource(inputs),
    maxTicks: Math.max(endTick, 1),
    counters: MANIFEST.counters,
    seats: 2,
  })
  do {
    seats[session.tick] = session.seat
  } while (session.step())
  return seats
}

/** A shared clock for the pages and the network between them. */
export class Clock {
  now = 0
}

type Message = {
  readonly at: number
  readonly events: readonly InputEvent[]
  readonly through: number
}

/**
 * One direction of a connection: what a page sends arrives at the far feed
 * `delayMs` later, in order. While stalled, nothing arrives; what was held
 * arrives at once when the stall ends.
 */
export class Wire {
  private readonly queue: Message[] = []
  stalledUntil = 0

  constructor(
    private readonly clock: Clock,
    readonly feed: RemoteInputFeed,
    private readonly delayMs: number,
  ) {}

  send(events: readonly InputEvent[], through: number): void {
    this.queue.push({ at: this.clock.now + this.delayMs, events, through })
  }

  deliver(): void {
    if (this.clock.now < this.stalledUntil) return
    while (this.queue.length > 0) {
      const next = this.queue[0] as Message
      if (next.at > this.clock.now) return
      this.queue.shift()
      this.feed.append(next.events)
      this.feed.confirm(next.through)
    }
  }
}

/**
 * A page's player. Before each frame, on its own turn, it aims five ticks
 * in, shoots at tick `shootAt` (10 unless given) and lets go 20 ticks later.
 * `eager` also presses on every frame of the other seat's turn, which the
 * paused queue must not record.
 */
export class PagePlayer {
  private turnStart = -1
  private aimed = false
  private shot = false
  private released = false
  private frames = 0

  constructor(
    private readonly host: GameHost,
    private readonly local: number,
    private readonly eager = false,
    private readonly shootAt = 10,
  ) {}

  beforeFrame(): void {
    const live = this.host.live
    if (live === null) throw new Error("a seat's page has a live queue")
    this.frames++
    const mine = this.host.seat === this.local
    if (!mine) {
      this.turnStart = -1
      if (this.eager) {
        live.push({ code: "aim", value: this.frames % 32, merge: "latest" })
        live.push({ code: "shoot", value: this.frames % 2 })
      }
      return
    }
    if (this.turnStart === -1) {
      this.turnStart = this.host.tick
      this.aimed = false
      this.shot = false
      this.released = false
    }
    const into = this.host.tick - this.turnStart
    if (!this.aimed && into >= 5) {
      this.aimed = true
      live.push({ code: "aim", value: (this.turnStart + this.local) % 32 })
    }
    if (!this.shot && into >= this.shootAt) {
      this.shot = true
      live.push({ code: "shoot", value: 1 })
    }
    if (!this.released && into >= this.shootAt + 20) {
      this.released = true
      live.push({ code: "shoot", value: 0 })
    }
  }
}

/**
 * A match server: one feed per seat, a session that runs the game through a
 * seated source as far as every seat has confirmed, and a relay of the
 * merged log to whoever watches.
 */
export class MatchServer {
  readonly feeds: readonly RemoteInputFeed[]
  readonly source: SeatedInputSource
  readonly session: Session
  private relayed = 0
  private relayedThrough = -1

  constructor(
    seed: string,
    private readonly relay: (
      events: readonly InputEvent[],
      through: number,
    ) => void,
  ) {
    this.feeds = [
      new RemoteInputFeed(MANIFEST.inputs),
      new RemoteInputFeed(MANIFEST.inputs),
    ]
    this.source = new SeatedInputSource(this.feeds)
    this.session = new Session({
      module: createTurnsGame(),
      seed,
      config: {},
      inputs: this.source,
      checkpointEvery: CHECKPOINT_EVERY,
      counters: MANIFEST.counters,
      seats: 2,
    })
  }

  /** Runs every tick both seats have confirmed, and relays what it took. */
  pump(): void {
    while (
      this.session.running &&
      this.feeds.every((feed) => feed.confirmedThrough >= this.session.tick)
    ) {
      this.session.step()
    }
    const through = this.session.tick - 1
    if (through === this.relayedThrough) return
    const merged = this.source.recorded()
    this.relay(merged.slice(this.relayed), through)
    this.relayed = merged.length
    this.relayedThrough = through
  }
}
