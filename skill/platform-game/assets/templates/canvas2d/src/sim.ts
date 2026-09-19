/**
 * Lane Runner - the simulation.
 *
 * Three lanes, rocks coming towards you, motes to collect. You move sideways;
 * a rock ends the run; ninety seconds ends it too. Small, but it exercises
 * everything the conformance suite checks: seeded randomness, a timer,
 * `dmath`, declared counters, effects, and a snapshot that restores exactly.
 *
 * This file is the whole simulation. It imports nothing but the kernel, it
 * touches no browser API, and it is the file `validate` is pointed at. The
 * renderer lives in `present.ts` and this file must never import it - a
 * simulation that can reach a canvas is a simulation that can decide a score
 * from one.
 *
 * The identical file sits in the sibling template. That is the point of the
 * boundary: changing the renderer changes nothing here, and the skill's tests
 * assert the two files are byte-identical.
 */

import {
  type Counters,
  dmath,
  type Effect,
  type GameModule,
  type InputEvent,
  Prng,
  type PrngState,
  type Snapshot,
  Timer,
  type TimerState,
} from "@clockwork2/kernel"
import { MANIFEST } from "./manifest"

export const LANES = 3
export const TRACK_LENGTH = 100
/** A rock every 24 ticks at the start, and sooner as the run goes on. */
export const SPAWN_INTERVAL = 24
export const MIN_SPAWN_INTERVAL = 8
export const TIME_LIMIT_TICKS = 60 * 90

export type Config = {
  readonly speed: number
  readonly startingLane: number
}

export const DEFAULT_CONFIG: Config = { speed: 1, startingLane: 1 }

type Rock = { id: number; lane: number; z: number }
type Mote = { id: number; lane: number; z: number }

export type View = {
  readonly lane: number
  readonly rocks: readonly Rock[]
  readonly motes: readonly Mote[]
  readonly motesTaken: number
  readonly ticks: number
  readonly over: boolean
  /** A wobble the renderer can lean the ship by. Part of the simulation, so
   * every player sees the same one. */
  readonly sway: number
}

export class LaneRunner implements GameModule<View, Config> {
  /** The platform reads this without running the game. */
  readonly manifest = MANIFEST
  private config: Config = DEFAULT_CONFIG
  private rng!: Prng
  private spawnRng!: Prng
  private timer = new Timer()
  private lane = 1
  private rocks: Rock[] = []
  private motes: Mote[] = []
  private nextId = 1
  private ticks = 0
  private motesTaken = 0
  private over = false
  private pending: Effect[] = []

  init(seed: string, config: Config = DEFAULT_CONFIG): void {
    this.config = { ...DEFAULT_CONFIG, ...config }
    this.rng = new Prng(seed)
    // A named sub-stream, so adding a draw to one system cannot shift the
    // other's sequence and quietly change every recorded session.
    this.spawnRng = this.rng.stream("spawn")
    this.timer = new Timer()
    // A one-shot that re-arms itself, rather than `every`: the interval
    // shrinks as the run goes on, and `every` would leave the old schedule
    // running beside the new one. One pending entry at a time, always.
    this.timer.define("spawn", () => {
      this.spawn()
      this.timer.after("spawn", this.spawnInterval())
    })
    this.timer.after("spawn", SPAWN_INTERVAL)
    this.lane = Math.min(Math.max(this.config.startingLane, 0), LANES - 1)
    this.rocks = []
    this.motes = []
    this.nextId = 1
    this.ticks = 0
    this.motesTaken = 0
    this.over = false
    this.pending = []
  }

  tick(inputs: readonly InputEvent[]): void {
    if (this.over) return

    for (const input of inputs) {
      if (input.value <= 0) continue
      if (input.code === "left" && this.lane > 0) this.lane--
      if (input.code === "right" && this.lane < LANES - 1) this.lane++
    }

    const speed = this.config.speed
    for (const rock of this.rocks) rock.z -= speed
    for (const mote of this.motes) mote.z -= speed

    for (const rock of this.rocks) {
      if (rock.z <= 0 && rock.z > -speed && rock.lane === this.lane) {
        this.over = true
        this.pending.push({ type: "sound", data: "hit" })
      }
    }
    this.motes = this.motes.filter((mote) => {
      if (mote.z <= 0 && mote.z > -speed && mote.lane === this.lane) {
        this.motesTaken++
        this.pending.push({ type: "sound", data: "mote" })
        return false
      }
      return mote.z > -speed
    })
    this.rocks = this.rocks.filter((rock) => rock.z > -speed)

    this.timer.advance()
    this.ticks++
    if (this.ticks >= TIME_LIMIT_TICKS) this.over = true
  }

  private spawn(): void {
    const lane = this.spawnRng.randomInt(0, LANES - 1)
    this.rocks.push({ id: this.nextId++, lane, z: TRACK_LENGTH })
    if (this.spawnRng.randomBoolean(0.5)) {
      // One of the two lanes the rock is not in, so there is always somewhere
      // to go.
      const free = (lane + 1 + this.spawnRng.randomInt(0, LANES - 2)) % LANES
      this.motes.push({ id: this.nextId++, lane: free, z: TRACK_LENGTH })
    }
  }

  /**
   * Rocks arrive faster as the run goes on.
   *
   * Some form of this is not optional: check 3 replays the game with an idle
   * player, a chaos log and the platform's bot, and every one of them has to
   * reach an ending. A game that a good player can hold forever is a game the
   * platform cannot bound what it pays to replay.
   */
  private spawnInterval(): number {
    return Math.max(
      MIN_SPAWN_INTERVAL,
      SPAWN_INTERVAL - Math.floor(this.ticks / 600),
    )
  }

  view(): View {
    return {
      lane: this.lane,
      rocks: this.rocks.map((rock) => ({ ...rock })),
      motes: this.motes.map((mote) => ({ ...mote })),
      motesTaken: this.motesTaken,
      ticks: this.ticks,
      over: this.over,
      // dmath, never Math.sin: the host and the validator have to agree on
      // this number, and `Math.sin` is implementation-defined.
      sway: dmath.sin(this.ticks / 30),
    }
  }

  snapshot(): Snapshot {
    return {
      config: { ...this.config },
      lane: this.lane,
      rocks: this.rocks.map((rock) => ({ ...rock })),
      motes: this.motes.map((mote) => ({ ...mote })),
      nextId: this.nextId,
      ticks: this.ticks,
      motesTaken: this.motesTaken,
      over: this.over,
      rng: this.rng.exportState() as unknown as Snapshot,
      timer: this.timer.exportState() as unknown as Snapshot,
    }
  }

  restore(snapshot: Snapshot): void {
    const s = snapshot as unknown as {
      config: Config
      lane: number
      rocks: Rock[]
      motes: Mote[]
      nextId: number
      ticks: number
      motesTaken: number
      over: boolean
      rng: PrngState
      timer: TimerState
    }
    // init() first, so the timer's handlers exist to be restored onto. A
    // restored timer holds names, not functions; nothing can serialise a
    // closure.
    this.init("restored", s.config)
    this.lane = s.lane
    this.rocks = s.rocks.map((rock) => ({ ...rock }))
    this.motes = s.motes.map((mote) => ({ ...mote }))
    this.nextId = s.nextId
    this.ticks = s.ticks
    this.motesTaken = s.motesTaken
    this.over = s.over
    // One call restores the sub-streams too, in place, so `this.spawnRng`
    // still points at the right generator and must not be re-derived.
    this.rng.importState(s.rng)
    this.timer.importState(s.timer)
    this.pending = []
  }

  score(): Counters {
    return { motes: this.motesTaken, ticksSurvived: this.ticks }
  }

  isOver(): boolean {
    return this.over
  }

  effects(): readonly Effect[] {
    const drained = this.pending
    this.pending = []
    return drained
  }
}
