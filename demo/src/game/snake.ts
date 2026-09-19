/**
 * The Snake demo, as a Clockwork 2 game module.
 *
 * Same game as Clockwork 1's demo: a 25 by 25 grid, a snake that wraps at the
 * edges, apples that expire, walls that keep arriving, one bomb, and fifty
 * apples to win. What changed is everything around it - the loop, where the
 * clock lives, how sound leaves the simulation, and the fact that every piece
 * of state that decides the game is in the snapshot.
 */

import {
  CollisionGrid,
  GameObjectGroup,
  Vector2D,
} from "@clockwork2/compat-clockwork1"
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
import { Apple, Bomb, Explosion, Snake, Wall } from "./objects"

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

export class SnakeGame implements GameModule<SnakeView, SnakeConfig> {
  readonly manifest = MANIFEST

  private config: SnakeConfig = DEFAULT_CONFIG
  private rng!: Prng
  private timer = new Timer()
  private snake!: Snake
  private apples = new GameObjectGroup<Apple>("apple")
  private walls = new GameObjectGroup<Wall>("wall")
  private bomb: Bomb | null = null
  private explosion: Explosion | null = null
  /** Walls and the bomb. Apples are checked directly; there are few of them. */
  private obstacles = new CollisionGrid()
  private pending: Effect[] = []
  private ticks = 0
  private nextId = 1
  private applesEaten = 0
  private outcome: Terminal = "playing"

  init(seed: string, config: SnakeConfig): void {
    this.config = { ...DEFAULT_CONFIG, ...config }
    this.rng = new Prng(seed)
    this.apples = new GameObjectGroup<Apple>("apple")
    this.walls = new GameObjectGroup<Wall>("wall")
    this.obstacles = new CollisionGrid()
    this.pending = []
    this.ticks = 0
    this.nextId = 1
    this.applesEaten = 0
    this.outcome = "playing"
    this.explosion = null

    const centre = Math.floor(GAME_CONFIG.GRID_SIZE / 2)
    this.snake = new Snake("snake", new Vector2D(centre, centre))

    this.bomb = new Bomb(
      "bomb",
      new Vector2D(this.config.bombX, this.config.bombY),
    )
    this.obstacles.add(this.config.bombX, this.config.bombY, { id: "bomb" })

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
    this.timer.define("sweep", () => {
      this.apples.clearDestroyed()
      this.walls.clearDestroyed()
    })
    this.timer.every("move", GAME_CONFIG.SNAKE_MOVE_INTERVAL)
    this.timer.every("spawnWall", GAME_CONFIG.WALL_SPAWN_INTERVAL)
    this.timer.every("expireApples", GAME_CONFIG.APPLE_CLEANUP_INTERVAL)
    this.timer.every("sweep", GAME_CONFIG.DESTROYED_CLEANUP_INTERVAL)

    this.spawnApple()
  }

  private id(prefix: string): string {
    return `${prefix}-${this.nextId++}`
  }

  /** A cell nothing is standing on. Null when the board is full. */
  private freeCell(stream: Prng): Vector2D | null {
    const size = GAME_CONFIG.GRID_SIZE
    for (let attempt = 0; attempt < 100; attempt++) {
      const point = new Vector2D(
        stream.randomInt(0, size - 1),
        stream.randomInt(0, size - 1),
      )
      if (this.obstacles.occupied(point.x, point.y)) continue
      if (this.snake.occupies(point)) continue
      if (this.apples.active().some((apple) => apple.position.equals(point)))
        continue
      return point
    }
    return null
  }

  private spawnApple(): void {
    const point = this.freeCell(this.rng.stream("apples"))
    if (point === null) return
    this.apples.add(new Apple(this.id("apple"), point, this.ticks))
  }

  private spawnWall(): void {
    const stream = this.rng.stream("walls")
    const horizontal = stream.randomBoolean()
    for (let attempt = 0; attempt < 40; attempt++) {
      const point = this.freeCell(stream)
      if (point === null) return
      const wall = new Wall(this.id("wall"), point, horizontal)
      // A wall may not land on the snake, on an apple, or on the bomb; if any
      // of its cells is taken, try somewhere else.
      const clear = wall
        .cells()
        .every(
          (cell) =>
            !this.obstacles.occupied(cell.x, cell.y) &&
            !this.snake.occupies(cell) &&
            !this.apples.active().some((apple) => apple.position.equals(cell)),
        )
      if (!clear) continue
      this.walls.add(wall)
      for (const cell of wall.cells())
        this.obstacles.add(cell.x, cell.y, { id: wall.id })
      return
    }
  }

  private expireApples(): void {
    let expired = false
    for (const apple of this.apples.active()) {
      if (this.ticks - apple.spawnedAt < GAME_CONFIG.APPLE_TIMEOUT) continue
      apple.destroy()
      expired = true
    }
    if (expired) this.spawnApple()
  }

  /** One grid move: the whole of the game's rules, in the order they fire. */
  private step(): void {
    if (this.outcome !== "playing" || this.snake.frozen) return

    const eaten = this.appleUnderNextCell()
    this.snake.move(eaten !== null)

    if (eaten !== null) {
      eaten.destroy()
      this.applesEaten++
      this.pending.push({ type: "sound", data: "eat" })
      if (this.applesEaten >= this.config.targetApples) {
        this.outcome = "won"
        return
      }
      this.spawnApple()
    }

    const head = this.snake.head

    if (this.bomb !== null && head.equals(this.bomb.position)) {
      // The snake stops here and the run ends when the explosion finishes, so
      // the effect is part of the game rather than a flourish over the top.
      this.snake.frozen = true
      this.explosion = new Explosion(
        this.id("boom"),
        head,
        this.rng.stream("fx"),
      )
      this.pending.push({ type: "sound", data: "explosion" })
      return
    }

    if (this.obstacles.occupied(head.x, head.y)) {
      this.pending.push({ type: "sound", data: "thud" })
      this.outcome = "died"
      return
    }

    // From index 1, because the head is allowed to be where the head is.
    if (this.snake.occupies(head, 1)) {
      this.pending.push({ type: "sound", data: "thud" })
      this.outcome = "died"
    }
  }

  private appleUnderNextCell(): Apple | null {
    const size = GAME_CONFIG.GRID_SIZE
    const direction = this.snake.queued ?? this.snake.direction
    const delta = {
      UP: { x: 0, y: -1 },
      DOWN: { x: 0, y: 1 },
      LEFT: { x: -1, y: 0 },
      RIGHT: { x: 1, y: 0 },
    }[direction]
    const head = this.snake.head
    const next = new Vector2D(
      (head.x + delta.x + size) % size,
      (head.y + delta.y + size) % size,
    )
    for (const apple of this.apples.active()) {
      if (apple.position.equals(next)) return apple
    }
    return null
  }

  tick(inputs: readonly InputEvent[]): void {
    for (const input of inputs) {
      if (input.value !== 1) continue
      switch (input.code) {
        case "up":
          this.snake.turn(Direction.UP)
          break
        case "down":
          this.snake.turn(Direction.DOWN)
          break
        case "left":
          this.snake.turn(Direction.LEFT)
          break
        case "right":
          this.snake.turn(Direction.RIGHT)
          break
        default:
          break
      }
    }

    this.timer.advance()

    if (this.explosion !== null) {
      this.explosion.update()
      if (this.explosion.destroyed) {
        this.explosion = null
        this.outcome = "died"
      }
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
      apples: this.apples.active().map((apple) => ({
        id: apple.id,
        x: apple.position.x,
        y: apple.position.y,
        ripeness: Math.min(
          1,
          (this.ticks - apple.spawnedAt) / GAME_CONFIG.APPLE_TIMEOUT,
        ),
      })),
      walls: this.walls.active().map((wall) => ({
        id: wall.id,
        x: wall.position.x,
        y: wall.position.y,
        horizontal: wall.horizontal,
      })),
      bomb:
        this.bomb === null
          ? null
          : { x: this.bomb.position.x, y: this.bomb.position.y },
      explosion:
        this.explosion === null
          ? null
          : {
              progress: this.explosion.progress,
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
    return {
      config: { ...this.config },
      ticks: this.ticks,
      nextId: this.nextId,
      applesEaten: this.applesEaten,
      outcome: this.outcome,
      snake: this.snake.serialize() as unknown as Snapshot,
      apples: this.apples.serialize() as unknown as Snapshot,
      walls: this.walls.serialize() as unknown as Snapshot,
      bomb:
        this.bomb === null
          ? null
          : (this.bomb.serialize() as unknown as Snapshot),
      explosion:
        this.explosion === null
          ? null
          : (this.explosion.serialize() as unknown as Snapshot),
      rng: this.rng.exportState() as unknown as Snapshot,
      timer: this.timer.exportState() as unknown as Snapshot,
    }
  }

  restore(snapshot: Snapshot): void {
    const s = snapshot as unknown as {
      config: SnakeConfig
      ticks: number
      nextId: number
      applesEaten: number
      outcome: Terminal
      snake: Record<string, unknown>
      apples: Array<Record<string, unknown>>
      walls: Array<Record<string, unknown>>
      bomb: Record<string, unknown> | null
      explosion: Record<string, unknown> | null
      rng: PrngState
      timer: TimerState
    }

    // init first, so the timer handlers exist before the schedule is bound
    // back onto them and every group is fresh.
    this.init("restored", s.config)

    this.ticks = s.ticks
    this.nextId = s.nextId
    this.applesEaten = s.applesEaten
    this.outcome = s.outcome
    this.snake.restore(s.snake as never)

    this.apples = new GameObjectGroup<Apple>("apple")
    for (const record of s.apples) {
      const apple = new Apple(
        record.id as string,
        Vector2D.deserialize(record.position as { x: number; y: number }),
        record.spawnedAt as number,
      )
      apple.restoreBase(record as never)
      apple.spawnedAt = record.spawnedAt as number
      this.apples.add(apple)
    }

    this.walls = new GameObjectGroup<Wall>("wall")
    this.obstacles = new CollisionGrid()
    for (const record of s.walls) {
      const wall = new Wall(
        record.id as string,
        Vector2D.deserialize(record.position as { x: number; y: number }),
        record.horizontal as boolean,
      )
      wall.restoreBase(record as never)
      wall.horizontal = record.horizontal as boolean
      this.walls.add(wall)
      if (!wall.destroyed) {
        for (const cell of wall.cells())
          this.obstacles.add(cell.x, cell.y, { id: wall.id })
      }
    }

    if (s.bomb === null) {
      this.bomb = null
    } else {
      this.bomb = new Bomb(
        s.bomb.id as string,
        Vector2D.deserialize(s.bomb.position as { x: number; y: number }),
      )
      this.bomb.restoreBase(s.bomb as never)
      this.obstacles.add(this.bomb.position.x, this.bomb.position.y, {
        id: "bomb",
      })
    }

    if (s.explosion === null) {
      this.explosion = null
    } else {
      const explosion = new Explosion(
        s.explosion.id as string,
        Vector2D.deserialize(s.explosion.position as { x: number; y: number }),
        this.rng.stream("fx"),
      )
      explosion.restoreBase(s.explosion as never)
      explosion.age = s.explosion.age as number
      explosion.particles = (
        s.explosion.particles as Array<{
          x: number
          y: number
          vx: number
          vy: number
        }>
      ).map((particle) => ({ ...particle }))
      this.explosion = explosion
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
