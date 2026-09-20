/**
 * A conforming game, used as the suite's positive control.
 *
 * Every check has to pass on this and fail on its matching non-conformant
 * neighbour, or the error codes the skill documents are not worth anything.
 */

import {
  type Counters,
  dmath,
  type Effect,
  type GameModule,
  type InputEvent,
  type Manifest,
  Prng,
  type PrngState,
  type Snapshot,
  Timer,
  type TimerState,
} from "@clockwork2/kernel"

export const MANIFEST: Manifest = {
  schemaVersion: 1,
  id: "conforming-fixture",
  version: "1.0.0",
  name: "Conforming Fixture",
  kernel: { version: "0.1.0" },
  session: { tickHz: 60, maxTicks: 3600, maxWallSeconds: 120, hasEnding: true },
  inputs: { map: { push: [{ code: "Space", device: "key", label: "Push" }] } },
  counters: [
    { name: "score", direction: "up", monotonic: true },
    { name: "ticksSurvived", direction: "up", monotonic: true },
  ],
  rankBy: ["score"],
  tiePolicy: "shared",
  capabilities: {
    deterministic: true,
    physics: "none",
    renderer: "canvas2d",
    multiplayer: false,
  },
}

export class ConformingGame implements GameModule {
  readonly manifest = MANIFEST
  private rng!: Prng
  private timer = new Timer()
  private angle = 0
  private value = 0
  private ticks = 0
  private pending: Effect[] = []

  init(seed: string): void {
    this.rng = new Prng(seed)
    this.timer = new Timer()
    this.timer.define("beat", () => {
      this.value += this.rng.randomInt(1, 3)
      this.pending.push({ type: "sound", data: "beat" })
    })
    this.timer.every("beat", 30)
    this.angle = 0
    this.value = 0
    this.ticks = 0
    this.pending = []
  }

  tick(inputs: readonly InputEvent[]): void {
    for (const input of inputs) {
      if (input.code === "push" && input.value > 0) this.value += 1
    }
    this.angle = dmath.wrapAngle(this.angle + 0.017)
    this.value += dmath.cos(this.angle) > 0.99 ? 1 : 0
    this.timer.advance()
    this.ticks++
  }

  view(): unknown {
    return { angle: this.angle, value: this.value }
  }

  snapshot(): Snapshot {
    return {
      angle: this.angle,
      value: this.value,
      ticks: this.ticks,
      rng: this.rng.exportState() as unknown as Snapshot,
      timer: this.timer.exportState() as unknown as Snapshot,
    }
  }

  restore(snapshot: Snapshot): void {
    const s = snapshot as unknown as {
      angle: number
      value: number
      ticks: number
      rng: PrngState
      timer: TimerState
    }
    this.angle = s.angle
    this.value = s.value
    this.ticks = s.ticks
    this.rng.importState(s.rng)
    this.timer.importState(s.timer)
    this.pending = []
  }

  score(): Counters {
    return { score: Math.floor(this.value), ticksSurvived: this.ticks }
  }

  isOver(): boolean {
    return this.ticks >= 1800
  }

  effects(): readonly Effect[] {
    const drained = this.pending
    this.pending = []
    return drained
  }
}

export default function createGame(): ConformingGame {
  return new ConformingGame()
}
