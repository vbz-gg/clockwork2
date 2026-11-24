/**
 * A conforming game for two seats that take turns, used as the positive
 * control for seats and by the kernel's and the host's seat tests.
 *
 * Each turn the acting seat sets `aim` and presses `shoot`. The shot rolls
 * for a few ticks, scores by how near it stops to a target drawn from the
 * seed, and the turn passes. A seat that has not shot within `TURN_TICKS`
 * loses the shot. The run ends when both seats have taken `SHOTS` turns.
 *
 * `shoot` is a press the game holds: a seat cannot fire again until it
 * lets go. When the turn passes the game lets go itself, because a turn's
 * held inputs end with it and the host records no release for them.
 */

import {
  type Counters,
  type Effect,
  type GameModule,
  type InputEvent,
  type Manifest,
  Prng,
  type PrngState,
  type Snapshot,
} from "@clockwork2/engine"

export const TURN_TICKS = 180
export const SHOTS = 4

export const MANIFEST: Manifest = {
  schemaVersion: 3,
  id: "seats-fixture",
  version: "1.0.0",
  name: "Seats Fixture",
  kernel: { version: "0.1.0" },
  session: { tickHz: 60, hasEnding: true, seats: 2 },
  inputs: {
    aim: { min: 0, max: 31, label: "Aim" },
    shoot: { min: 0, max: 1, label: "Shoot" },
  },
  counters: [
    { name: "points0", direction: "up", monotonic: true },
    { name: "points1", direction: "up", monotonic: true },
    { name: "shots", direction: "up", monotonic: true },
    { name: "ticks", direction: "up", monotonic: true },
  ],
  capabilities: {
    deterministic: true,
    physics: "none",
    renderer: "canvas2d",
    multiplayer: false,
  },
}

type Ball = { x: number; v: number }

/** Everything but `seat()`, so a variant can leave it out. */
export class TurnsWithoutSeat implements GameModule {
  readonly manifest: Manifest = MANIFEST
  protected rng!: Prng
  protected turn = 0
  protected aim = 0
  protected held = false
  protected ball: Ball | null = null
  protected target = 0
  protected turnTicks = 0
  protected shots: [number, number] = [0, 0]
  protected points: [number, number] = [0, 0]
  protected ticks = 0
  private pending: Effect[] = []

  init(seed: string): void {
    this.rng = new Prng(seed).stream("table")
    this.turn = 0
    this.aim = 0
    this.held = false
    this.ball = null
    this.target = this.rng.randomInt(10, 600)
    this.turnTicks = 0
    this.shots = [0, 0]
    this.points = [0, 0]
    this.ticks = 0
    this.pending = []
  }

  tick(inputs: readonly InputEvent[]): void {
    if (this.isOver()) return
    for (const input of inputs) {
      if (input.code === "aim") this.aim = input.value
      if (input.code === "shoot") {
        if (input.value === 0) {
          this.held = false
        } else if (!this.held) {
          this.held = true
          if (this.ball === null) this.ball = { x: 0, v: 4 + this.aim }
        }
      }
    }
    this.ticks++
    this.turnTicks++
    const ball = this.ball
    if (ball !== null) {
      ball.x += ball.v
      ball.v -= 1
      if (ball.v === 0) {
        const off = Math.abs(ball.x - this.target)
        this.points[this.turn as 0 | 1] += Math.max(0, 40 - Math.floor(off / 4))
        this.pending.push({ type: "sound", data: "stop" })
        this.pass()
      }
    } else if (this.turnTicks >= TURN_TICKS) {
      this.pass()
    }
  }

  /** The shot is taken; the other seat's turn begins with nothing held. */
  private pass(): void {
    this.shots[this.turn as 0 | 1]++
    this.turn = 1 - this.turn
    this.aim = 0
    this.held = false
    this.ball = null
    this.turnTicks = 0
    this.target = this.rng.randomInt(10, 600)
  }

  view(): unknown {
    return { turn: this.turn, ball: this.ball, target: this.target }
  }

  snapshot(): Snapshot {
    return {
      turn: this.turn,
      aim: this.aim,
      held: this.held,
      ball: this.ball === null ? null : { ...this.ball },
      target: this.target,
      turnTicks: this.turnTicks,
      shots: [...this.shots],
      points: [...this.points],
      ticks: this.ticks,
      rng: this.rng.exportState() as unknown as Snapshot,
    }
  }

  restore(snapshot: Snapshot): void {
    const s = snapshot as unknown as {
      turn: number
      aim: number
      held: boolean
      ball: Ball | null
      target: number
      turnTicks: number
      shots: [number, number]
      points: [number, number]
      ticks: number
      rng: PrngState
    }
    this.turn = s.turn
    this.aim = s.aim
    this.held = s.held
    this.ball = s.ball === null ? null : { ...s.ball }
    this.target = s.target
    this.turnTicks = s.turnTicks
    this.shots = [...s.shots]
    this.points = [...s.points]
    this.ticks = s.ticks
    this.rng.importState(s.rng)
    this.pending = []
  }

  score(): Counters {
    return {
      points0: this.points[0],
      points1: this.points[1],
      shots: this.shots[0] + this.shots[1],
      ticks: this.ticks,
    }
  }

  isOver(): boolean {
    return this.shots[0] >= SHOTS && this.shots[1] >= SHOTS
  }

  effects(): readonly Effect[] {
    const drained = this.pending
    this.pending = []
    return drained
  }
}

export class TurnsGame extends TurnsWithoutSeat {
  seat(): number {
    return this.turn
  }
}

export default function createGame(): TurnsGame {
  return new TurnsGame()
}
