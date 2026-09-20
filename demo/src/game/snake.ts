/**
 * The Snake demo, as a Clockwork 2 game module.
 *
 * A 25 by 25 grid, a snake that wraps at the edges, apples that expire, walls
 * that keep arriving, one bomb, and fifty apples to win.
 *
 * The state is plain records and arrays (see `state.ts`), so `snapshot()`
 * copies it and `restore()` reads it back. Nothing registers itself anywhere,
 * nothing is stepped by a pass the game cannot see, and every value that
 * decides the game is in the snapshot.
 */

import type {
  Counters,
  Effect,
  GameModule,
  InputEvent,
  Snapshot,
} from "@clockwork2/kernel"
import {
  Prng,
  type PrngState,
  Timer,
  type TimerState,
} from "@clockwork2/kernel"
import { Direction, GAME_CONFIG } from "./constants"
import { MANIFEST } from "./manifest"
import {
  type Apple,
  cellKey,
  createExplosion,
  createSnake,
  type Explosion,
  explosionProgress,
  moveSnake,
  nextCell,
  type Particle,
  type Point,
  type Snake,
  samePoint,
  snakeHead,
  snakeOccupies,
  stepExplosion,
  turnSnake,
  type Wall,
  wallCells,
} from "./state"

export type SnakeConfig = {
  readonly bombX: number
  readonly bombY: number
  readonly targetApples: number
}

export const DEFAULT_CONFIG: SnakeConfig = {
  bombX: 6,
  bombY: 6,
  targetApples: GAME_CONFIG.TARGET_APPLES,
}

export type SnakeView = {
  readonly gridSize: number
  readonly segments: ReadonlyArray<{ readonly x: number; readonly y: number }>
  readonly direction: Direction
  readonly apples: ReadonlyArray<{
    readonly id: string
    readonly x: number
    readonly y: number
    /** 0 when it appeared, 1 when it is about to go. */
    readonly ripeness: number
  }>
  readonly walls: ReadonlyArray<{
    readonly id: string
    readonly x: number
    readonly y: number
    readonly horizontal: boolean
  }>
  readonly bomb: { readonly x: number; readonly y: number } | null
  readonly explosion: {
    readonly progress: number
    readonly particles: ReadonlyArray<{
      readonly x: number
      readonly y: number
    }>
  } | null
  readonly applesEaten: number
  readonly target: number
  readonly alive: boolean
  readonly won: boolean
  readonly tick: number
}

type Terminal = "playing" | "won" | "died"

/** The snapshot's shape, so `restore()` reads fields rather than casts. */
type Saved = {
  readonly config: SnakeConfig
  readonly ticks: number
  readonly nextId: number
  readonly applesEaten: number
  readonly outcome: Terminal
  readonly snake: {
    readonly segments: readonly Point[]
    readonly direction: Direction
    readonly queued: Direction | null
    readonly frozen: boolean
  }
  readonly apples: readonly Apple[]
  readonly walls: readonly Wall[]
  readonly bomb: Point | null
  readonly explosion: {
    readonly particles: readonly Particle[]
    readonly age: number
  } | null
  readonly rng: PrngState
  readonly timer: TimerState
}

export class SnakeGame implements GameModule<SnakeView, SnakeConfig> {
  readonly manifest = MANIFEST

  private config: SnakeConfig = DEFAULT_CONFIG
  private rng!: Prng
  private timer = new Timer()
  private snake!: Snake
  private apples: Apple[] = []
  private walls: Wall[] = []
  private bomb: Point | null = null
  private explosion: Explosion | null = null
  /**
   * The cells walls and the bomb stand on.
   *
   * A set of `"x,y"` keys rather than a spatial index, because the grid is
   * integers and an exact lookup is both cheaper and correct. Apples are
   * checked against their array; there are never many.
   */
  private obstacles = new Set<string>()
  private pending: Effect[] = []
  private ticks = 0
  private nextId = 1
  private applesEaten = 0
  private outcome: Terminal = "playing"

  init(seed: string, config: SnakeConfig): void {
    this.config = { ...DEFAULT_CONFIG, ...config }
    this.rng = new Prng(seed)
    this.apples = []
    this.walls = []
    this.obstacles = new Set()
    this.pending = []
    this.ticks = 0
    this.nextId = 1
    this.applesEaten = 0
    this.outcome = "playing"
    this.explosion = null

    const centre = Math.floor(GAME_CONFIG.GRID_SIZE / 2)
    this.snake = createSnake({ x: centre, y: centre })

    this.bomb = { x: this.config.bombX, y: this.config.bombY }
    this.obstacles.add(cellKey(this.bomb))

    this.timer = new Timer()
    this.timer.define("move", () => {
      this.step()
    })
    this.timer.define("spawnWall", () => {
      this.spawnWall()
    })
    this.timer.define("expireApples", () => {
      this.expireApples()
    })
    this.timer.every("move", GAME_CONFIG.SNAKE_MOVE_INTERVAL)
    this.timer.every("spawnWall", GAME_CONFIG.WALL_SPAWN_INTERVAL)
    this.timer.every("expireApples", GAME_CONFIG.APPLE_CLEANUP_INTERVAL)

    this.spawnApple()
  }

  private id(prefix: string): string {
    return `${prefix}-${this.nextId++}`
  }

  /** A cell nothing is standing on. Null when the board is full. */
  private freeCell(stream: Prng): Point | null {
    const size = GAME_CONFIG.GRID_SIZE
    for (let attempt = 0; attempt < 100; attempt++) {
      const point = {
        x: stream.randomInt(0, size - 1),
        y: stream.randomInt(0, size - 1),
      }
      if (this.obstacles.has(cellKey(point))) continue
      if (snakeOccupies(this.snake, point)) continue
      if (this.apples.some((apple) => samePoint(apple.at, point))) continue
      return point
    }
    return null
  }

  private spawnApple(): void {
    const at = this.freeCell(this.rng.stream("apples"))
    if (at === null) return
    this.apples.push({ id: this.id("apple"), at, spawnedAt: this.ticks })
  }

  private spawnWall(): void {
    const stream = this.rng.stream("walls")
    const horizontal = stream.randomBoolean()
    for (let attempt = 0; attempt < 40; attempt++) {
      const at = this.freeCell(stream)
      if (at === null) return
      const wall: Wall = { id: this.id("wall"), at, horizontal }
      // A wall may not land on the snake, on an apple, or on the bomb; if any
      // of its cells is taken, try somewhere else.
      const cells = wallCells(wall)
      const clear = cells.every(
        (cell) =>
          !this.obstacles.has(cellKey(cell)) &&
          !snakeOccupies(this.snake, cell) &&
          !this.apples.some((apple) => samePoint(apple.at, cell)),
      )
      if (!clear) continue
      this.walls.push(wall)
      for (const cell of cells) this.obstacles.add(cellKey(cell))
      return
    }
  }

  /** Drops the apples that have sat there too long, and replaces one of them. */
  private expireApples(): void {
    const kept = this.apples.filter(
      (apple) => this.ticks - apple.spawnedAt < GAME_CONFIG.APPLE_TIMEOUT,
    )
    if (kept.length === this.apples.length) return
    this.apples = kept
    this.spawnApple()
  }

  /** One grid move: the whole of the game's rules, in the order they fire. */
  private step(): void {
    if (this.outcome !== "playing" || this.snake.frozen) return

    const target = nextCell(this.snake)
    const eaten = this.apples.findIndex((apple) => samePoint(apple.at, target))
    moveSnake(this.snake, eaten >= 0)

    if (eaten >= 0) {
      this.apples.splice(eaten, 1)
      this.applesEaten++
      this.pending.push({ type: "sound", data: "eat" })
      if (this.applesEaten >= this.config.targetApples) {
        this.outcome = "won"
        return
      }
      this.spawnApple()
    }

    const head = snakeHead(this.snake)

    if (this.bomb !== null && samePoint(head, this.bomb)) {
      // The snake stops here and the run ends when the explosion finishes, so
      // the effect is part of the game rather than a flourish over the top.
      this.snake.frozen = true
      this.explosion = createExplosion(this.rng.stream("fx"), head)
      this.pending.push({ type: "sound", data: "explosion" })
      return
    }

    if (this.obstacles.has(cellKey(head))) {
      this.pending.push({ type: "sound", data: "thud" })
      this.outcome = "died"
      return
    }

    // From index 1, because the head is allowed to be where the head is.
    if (snakeOccupies(this.snake, head, 1)) {
      this.pending.push({ type: "sound", data: "thud" })
      this.outcome = "died"
    }
  }

  tick(inputs: readonly InputEvent[]): void {
    for (const input of inputs) {
      if (input.value !== 1) continue
      switch (input.code) {
        case "up":
          turnSnake(this.snake, Direction.UP)
          break
        case "down":
          turnSnake(this.snake, Direction.DOWN)
          break
        case "left":
          turnSnake(this.snake, Direction.LEFT)
          break
        case "right":
          turnSnake(this.snake, Direction.RIGHT)
          break
        default:
          break
      }
    }

    this.timer.advance()

    if (this.explosion !== null && stepExplosion(this.explosion)) {
      this.explosion = null
      this.outcome = "died"
    }

    this.ticks++
  }

  view(): SnakeView {
    return {
      gridSize: GAME_CONFIG.GRID_SIZE,
      segments: this.snake.segments.map((segment) => ({
        x: segment.x,
        y: segment.y,
      })),
      direction: this.snake.direction,
      apples: this.apples.map((apple) => ({
        id: apple.id,
        x: apple.at.x,
        y: apple.at.y,
        ripeness: Math.min(
          1,
          (this.ticks - apple.spawnedAt) / GAME_CONFIG.APPLE_TIMEOUT,
        ),
      })),
      walls: this.walls.map((wall) => ({
        id: wall.id,
        x: wall.at.x,
        y: wall.at.y,
        horizontal: wall.horizontal,
      })),
      bomb: this.bomb === null ? null : { x: this.bomb.x, y: this.bomb.y },
      explosion:
        this.explosion === null
          ? null
          : {
              progress: explosionProgress(this.explosion),
              particles: this.explosion.particles.map((particle) => ({
                x: particle.x,
                y: particle.y,
              })),
            },
      applesEaten: this.applesEaten,
      target: this.config.targetApples,
      alive: this.outcome !== "died",
      won: this.outcome === "won",
      tick: this.ticks,
    }
  }

  snapshot(): Snapshot {
    const state: Saved = {
      config: { ...this.config },
      ticks: this.ticks,
      nextId: this.nextId,
      applesEaten: this.applesEaten,
      outcome: this.outcome,
      snake: {
        segments: this.snake.segments.map((segment) => ({ ...segment })),
        direction: this.snake.direction,
        queued: this.snake.queued,
        frozen: this.snake.frozen,
      },
      apples: this.apples.map((apple) => ({ ...apple, at: { ...apple.at } })),
      walls: this.walls.map((wall) => ({ ...wall, at: { ...wall.at } })),
      bomb: this.bomb === null ? null : { ...this.bomb },
      explosion:
        this.explosion === null
          ? null
          : {
              age: this.explosion.age,
              particles: this.explosion.particles.map((particle) => ({
                ...particle,
              })),
            },
      rng: this.rng.exportState(),
      timer: this.timer.exportState(),
    }
    return state as unknown as Snapshot
  }

  restore(snapshot: Snapshot): void {
    const s = snapshot as unknown as Saved

    // init first, so the timer handlers exist before the schedule is bound
    // back onto them and every collection is fresh. The seed it is given here
    // does not survive: the generator's own seed travels in its state, which
    // is why a module restored from a snapshot draws the same values as the
    // run it came from.
    this.init("restored", s.config)

    this.ticks = s.ticks
    this.nextId = s.nextId
    this.applesEaten = s.applesEaten
    this.outcome = s.outcome

    this.snake = {
      segments: s.snake.segments.map((segment) => ({ ...segment })),
      direction: s.snake.direction,
      queued: s.snake.queued,
      frozen: s.snake.frozen,
    }

    this.apples = s.apples.map((apple) => ({ ...apple, at: { ...apple.at } }))

    this.walls = s.walls.map((wall) => ({ ...wall, at: { ...wall.at } }))
    this.obstacles = new Set()
    for (const wall of this.walls) {
      for (const cell of wallCells(wall)) this.obstacles.add(cellKey(cell))
    }

    this.bomb = s.bomb === null ? null : { ...s.bomb }
    if (this.bomb !== null) this.obstacles.add(cellKey(this.bomb))

    this.explosion =
      s.explosion === null
        ? null
        : {
            age: s.explosion.age,
            particles: s.explosion.particles.map((particle) => ({
              ...particle,
            })),
          }

    this.rng.importState(s.rng)
    this.timer.importState(s.timer)
    this.pending = []
  }

  score(): Counters {
    return {
      applesEaten: this.applesEaten,
      length: this.snake.segments.length,
      ticksSurvived: this.ticks,
    }
  }

  isOver(): boolean {
    return this.outcome !== "playing" && this.explosion === null
  }

  effects(): readonly Effect[] {
    if (this.pending.length === 0) return []
    const drained = this.pending
    this.pending = []
    return drained
  }
}

export function createGame(): SnakeGame {
  return new SnakeGame()
}
