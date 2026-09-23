/**
 * A small, complete game, used by the kernel's own tests, by the conformance
 * suite's self-checks, and by the cross-engine probe.
 *
 * It is here rather than in a test folder because everything that has to agree
 * about determinism needs the same subject. It deliberately touches every part
 * of the contract that is easy to get wrong: a seeded PRNG with a separate
 * visual sub-stream, named timers, dmath, declared counters, effects, and a
 * snapshot complete enough to restore from.
 *
 * The game: a ship drifts in a box. Collectibles appear on a timer. Steering
 * is two keys and a thrust; hitting a collectible scores, hitting a wall costs
 * a life.
 */

import type {
  Counters,
  Effect,
  GameModule,
  InputEvent,
  Snapshot,
} from "../contract.js"
import type { CounterDeclaration } from "../counters.js"
import * as dmath from "../dmath/index.js"
import type { Manifest } from "../manifest/types.js"
import { Prng, type PrngState } from "../prng/index.js"
import { Timer, type TimerState } from "../timer.js"

export type ReferenceConfig = {
  readonly arenaWidth: number
  readonly arenaHeight: number
  readonly spawnEveryTicks: number
  readonly targetScore: number
  readonly lives: number
  readonly hitCooldownTicks: number
  /** The run ends here even if nobody touches a key. */
  readonly timeLimitTicks: number
}

export const REFERENCE_CONFIG: ReferenceConfig = {
  arenaWidth: 640,
  arenaHeight: 480,
  spawnEveryTicks: 45,
  targetScore: 25,
  lives: 10,
  hitCooldownTicks: 30,
  timeLimitTicks: 60 * 60,
}

export const REFERENCE_COUNTERS: readonly CounterDeclaration[] = [
  { name: "score", direction: "up", monotonic: true, label: "Score" },
  { name: "collected", direction: "up", monotonic: true, label: "Collected" },
  { name: "ticksSurvived", direction: "up", monotonic: true, label: "Ticks" },
  { name: "livesLost", direction: "up", monotonic: true, label: "Lives lost" },
]

export const REFERENCE_MANIFEST: Manifest = {
  schemaVersion: 1,
  id: "reference-drift",
  version: "1.0.0",
  name: "Reference Drift",
  kernel: { version: "0.1.0" },
  session: {
    tickHz: 60,
    maxTicks: 60 * 60 * 5,
    maxWallSeconds: 360,
    hasEnding: true,
  },
  inputs: {
    map: {
      left: [{ code: "ArrowLeft", device: "key", label: "Turn left" }],
      right: [{ code: "ArrowRight", device: "key", label: "Turn right" }],
      thrust: [{ code: "ArrowUp", device: "key", label: "Thrust" }],
    },
  },
  counters: REFERENCE_COUNTERS,
  rankBy: ["score", "ticksSurvived"],
  tiePolicy: "shared",
  capabilities: {
    deterministic: true,
    physics: "none",
    renderer: "canvas2d",
    multiplayer: false,
  },
}

type Collectible = { x: number; y: number; value: number }

export type ReferenceView = {
  readonly shipX: number
  readonly shipY: number
  readonly heading: number
  readonly collectibles: readonly { readonly x: number; readonly y: number }[]
  readonly score: number
  readonly lives: number
}

const TURN_RATE = 0.045
const THRUST = 0.11
const DRAG = 0.992
const SHIP_RADIUS = 9
const PICKUP_RADIUS = 18

export class ReferenceGame
  implements GameModule<ReferenceView, ReferenceConfig>
{
  readonly manifest = REFERENCE_MANIFEST

  private config: ReferenceConfig = REFERENCE_CONFIG
  private rng!: Prng
  private timer = new Timer()
  private pending: Effect[] = []

  private x = 0
  private y = 0
  private vx = 0
  private vy = 0
  private heading = 0
  private turning = 0
  private thrusting = false
  private collectibles: Collectible[] = []
  private scoreValue = 0
  private collected = 0
  private livesLost = 0
  private ticks = 0
  private hitCooldown = 0
  private ended = false

  init(seed: string, config: ReferenceConfig): void {
    this.config = { ...REFERENCE_CONFIG, ...config }
    this.rng = new Prng(seed)
    this.timer = new Timer()
    this.timer.define("spawn", () => {
      this.spawn()
    })
    this.timer.every("spawn", this.config.spawnEveryTicks)

    this.x = this.config.arenaWidth / 2
    this.y = this.config.arenaHeight / 2
    this.vx = 0
    this.vy = 0
    this.heading = 0
    this.turning = 0
    this.thrusting = false
    this.collectibles = []
    this.scoreValue = 0
    this.collected = 0
    this.livesLost = 0
    this.ticks = 0
    this.hitCooldown = 0
    this.ended = false
    this.pending = []
    this.spawn()
  }

  private spawn(): void {
    // A dedicated sub-stream, so a purely visual draw elsewhere can never move
    // where a collectible appears.
    const place = this.rng.stream("spawn")
    this.collectibles.push({
      x: place.randomInt(20, this.config.arenaWidth - 20),
      y: place.randomInt(20, this.config.arenaHeight - 20),
      value: place.randomInt(1, 3),
    })
  }

  tick(inputs: readonly InputEvent[]): void {
    for (const input of inputs) {
      switch (input.code) {
        case "left":
          this.turning = input.value > 0 ? -1 : 0
          break
        case "right":
          this.turning = input.value > 0 ? 1 : 0
          break
        case "thrust":
          this.thrusting = input.value > 0
          break
        default:
          break
      }
    }

    this.heading = dmath.wrapAngle(this.heading + this.turning * TURN_RATE)
    if (this.thrusting) {
      this.vx += dmath.cos(this.heading) * THRUST
      this.vy += dmath.sin(this.heading) * THRUST
    }
    this.vx *= DRAG
    this.vy *= DRAG
    this.x += this.vx
    this.y += this.vy

    const hitWall =
      this.x < SHIP_RADIUS ||
      this.y < SHIP_RADIUS ||
      this.x > this.config.arenaWidth - SHIP_RADIUS ||
      this.y > this.config.arenaHeight - SHIP_RADIUS
    if (hitWall) {
      this.x = Math.min(
        Math.max(this.x, SHIP_RADIUS),
        this.config.arenaWidth - SHIP_RADIUS,
      )
      this.y = Math.min(
        Math.max(this.y, SHIP_RADIUS),
        this.config.arenaHeight - SHIP_RADIUS,
      )
      this.vx = -this.vx * 0.4
      this.vy = -this.vy * 0.4
      // A cooldown, so a ship held against a wall loses one life rather than
      // one per tick. Without it the run ends in four seconds and the bound
      // check proves nothing.
      if (this.hitCooldown === 0) {
        this.livesLost++
        this.hitCooldown = this.config.hitCooldownTicks
        this.pending.push({ type: "sound", data: "bump" })
      }
    }
    if (this.hitCooldown > 0) this.hitCooldown--

    const remaining: Collectible[] = []
    for (const item of this.collectibles) {
      const dx = item.x - this.x
      const dy = item.y - this.y
      if (dmath.hypot(dx, dy) <= PICKUP_RADIUS) {
        this.scoreValue += item.value
        this.collected++
        this.pending.push({ type: "sound", data: "collect" })
        continue
      }
      remaining.push(item)
    }
    this.collectibles = remaining

    this.timer.advance()
    this.ticks++

    if (this.scoreValue >= this.config.targetScore) this.ended = true
    if (this.livesLost >= this.config.lives) this.ended = true
    // Without a time limit an idle run never ends, and "the run is bounded"
    // becomes a promise the kernel's tick cap has to keep instead of the game.
    if (this.ticks >= this.config.timeLimitTicks) this.ended = true
  }

  view(): ReferenceView {
    return {
      shipX: this.x,
      shipY: this.y,
      heading: this.heading,
      collectibles: this.collectibles.map((c) => ({ x: c.x, y: c.y })),
      score: this.scoreValue,
      lives: this.config.lives - this.livesLost,
    }
  }

  snapshot(): Snapshot {
    return {
      x: this.x,
      y: this.y,
      vx: this.vx,
      vy: this.vy,
      heading: this.heading,
      turning: this.turning,
      thrusting: this.thrusting,
      collectibles: this.collectibles.map((c) => ({
        x: c.x,
        y: c.y,
        value: c.value,
      })),
      score: this.scoreValue,
      collected: this.collected,
      livesLost: this.livesLost,
      ticks: this.ticks,
      hitCooldown: this.hitCooldown,
      ended: this.ended,
      rng: this.rng.exportState() as unknown as Snapshot,
      timer: this.timer.exportState() as unknown as Snapshot,
      config: { ...this.config },
    }
  }

  restore(snapshot: Snapshot): void {
    const s = snapshot as unknown as {
      x: number
      y: number
      vx: number
      vy: number
      heading: number
      turning: number
      thrusting: boolean
      collectibles: Collectible[]
      score: number
      collected: number
      livesLost: number
      ticks: number
      hitCooldown: number
      ended: boolean
      rng: PrngState
      timer: TimerState
      config: ReferenceConfig
    }
    this.config = { ...s.config }
    // The handlers have to exist before the schedule is bound back onto them.
    if (this.rng === undefined) this.rng = new Prng("restored")
    this.timer = new Timer()
    this.timer.define("spawn", () => {
      this.spawn()
    })
    this.timer.importState(s.timer)
    this.rng.importState(s.rng)
    this.x = s.x
    this.y = s.y
    this.vx = s.vx
    this.vy = s.vy
    this.heading = s.heading
    this.turning = s.turning
    this.thrusting = s.thrusting
    this.collectibles = s.collectibles.map((c) => ({ ...c }))
    this.scoreValue = s.score
    this.collected = s.collected
    this.livesLost = s.livesLost
    this.ticks = s.ticks
    this.hitCooldown = s.hitCooldown
    this.ended = s.ended
    this.pending = []
  }

  score(): Counters {
    return {
      score: this.scoreValue,
      collected: this.collected,
      ticksSurvived: this.ticks,
      livesLost: this.livesLost,
    }
  }

  isOver(): boolean {
    return this.ended
  }

  effects(): readonly Effect[] {
    if (this.pending.length === 0) return []
    const drained = this.pending
    this.pending = []
    return drained
  }
}

/** The default export shape a real bundle uses. */
export function createReferenceGame(): ReferenceGame {
  return new ReferenceGame()
}
