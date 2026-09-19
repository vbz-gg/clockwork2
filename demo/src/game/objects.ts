/**
 * The demo's game objects, on the Clockwork 1 compatibility library.
 *
 * They are close to their originals on purpose: this is a port, and a port
 * that rewrote the game would prove nothing about porting. What changed is
 * where they sit. Nothing registers itself with an engine, nothing is stepped
 * by a hidden pass, and every piece of state that decides the game is in the
 * snapshot.
 */

import {
  GameObject,
  type SerializedGameObject,
  Vector2D,
} from "@clockwork2/compat-clockwork1"
import { dmath, type Prng } from "@clockwork2/kernel"
import {
  DIRECTION_VECTORS,
  Direction,
  GAME_CONFIG,
  OPPOSITE,
} from "./constants"

export class Snake extends GameObject {
  segments: Vector2D[]
  direction: Direction = Direction.RIGHT
  /** Held until the next move, so two turns in one tick cannot fold it. */
  queued: Direction | null = null
  /** Set when the bomb goes off, so the explosion can finish playing. */
  frozen = false

  constructor(id: string, start: Vector2D) {
    super(id, start)
    this.segments = [start]
    for (let i = 1; i < GAME_CONFIG.SNAKE_INITIAL_LENGTH; i++) {
      this.segments.push(new Vector2D(start.x - i, start.y))
    }
  }

  getType(): string {
    return "snake"
  }

  get head(): Vector2D {
    return this.segments[0] as Vector2D
  }

  turn(direction: Direction): void {
    // A turn into the neck is ignored, the way it always was.
    if (OPPOSITE[direction] === this.direction) return
    this.queued = direction
  }

  /** One grid step, wrapping at the edges. Returns the cell it left. */
  move(grow: boolean): Vector2D {
    if (this.queued !== null) {
      this.direction = this.queued
      this.queued = null
    }
    const delta = DIRECTION_VECTORS[this.direction]
    const size = GAME_CONFIG.GRID_SIZE
    const head = this.head
    const next = new Vector2D(
      (head.x + delta.x + size) % size,
      (head.y + delta.y + size) % size,
    )
    this.segments.unshift(next)
    const tail = grow ? next : (this.segments.pop() as Vector2D)
    this.position = next
    this.needsRepaint = true
    return tail
  }

  occupies(point: Vector2D, fromIndex = 0): boolean {
    for (let i = fromIndex; i < this.segments.length; i++) {
      const segment = this.segments[i] as Vector2D
      if (segment.x === point.x && segment.y === point.y) return true
    }
    return false
  }

  override serialize(): SerializedGameObject {
    return {
      ...super.serialize(),
      segments: this.segments.map((segment) => segment.serialize()),
      direction: this.direction,
      queued: this.queued,
      frozen: this.frozen,
    }
  }

  restore(data: SerializedGameObject): void {
    this.restoreBase(data)
    this.segments = (data.segments as Array<{ x: number; y: number }>).map(
      (point) => Vector2D.deserialize(point),
    )
    this.direction = data.direction as Direction
    this.queued = data.queued as Direction | null
    this.frozen = data.frozen as boolean
  }
}

export class Apple extends GameObject {
  constructor(
    id: string,
    position: Vector2D,
    /** The tick it appeared, so its age is state rather than a timer. */
    public spawnedAt: number,
  ) {
    super(id, position)
  }

  getType(): string {
    return "apple"
  }

  override serialize(): SerializedGameObject {
    return { ...super.serialize(), spawnedAt: this.spawnedAt }
  }
}

export class Wall extends GameObject {
  constructor(
    id: string,
    position: Vector2D,
    /** Walls are two cells wide, laid horizontally or vertically. */
    public horizontal: boolean,
  ) {
    super(id, position)
  }

  getType(): string {
    return "wall"
  }

  cells(): readonly Vector2D[] {
    const size = GAME_CONFIG.GRID_SIZE
    const out = [this.position]
    for (let i = 1; i < GAME_CONFIG.WALL_SIZE; i++) {
      out.push(
        this.horizontal
          ? new Vector2D((this.position.x + i) % size, this.position.y)
          : new Vector2D(this.position.x, (this.position.y + i) % size),
      )
    }
    return out
  }

  override serialize(): SerializedGameObject {
    return { ...super.serialize(), horizontal: this.horizontal }
  }
}

export class Bomb extends GameObject {
  getType(): string {
    return "bomb"
  }
}

export interface Particle {
  x: number
  y: number
  vx: number
  vy: number
}

export class Explosion extends GameObject {
  particles: Particle[] = []
  age = 0

  constructor(id: string, position: Vector2D, prng: Prng) {
    super(id, position)
    // Clockwork 1's version fell back to Math.random when it had no engine,
    // which is a determinism hole in a particle effect that decides when the
    // game ends. Here the generator is required.
    for (let i = 0; i < GAME_CONFIG.EXPLOSION_PARTICLES; i++) {
      const angle = prng.randomFloat(0, 6.283185307179586)
      const speed = prng.randomFloat(0.02, 0.12)
      this.particles.push({
        x: position.x,
        y: position.y,
        vx: dmath.cos(angle) * speed,
        vy: dmath.sin(angle) * speed,
      })
    }
  }

  getType(): string {
    return "explosion"
  }

  override update(): void {
    this.age++
    for (const particle of this.particles) {
      particle.x += particle.vx
      particle.y += particle.vy
      particle.vy += 0.002
    }
    this.needsRepaint = true
    if (this.age >= GAME_CONFIG.EXPLOSION_DURATION) this.destroy()
  }

  get progress(): number {
    return Math.min(1, this.age / GAME_CONFIG.EXPLOSION_DURATION)
  }

  override serialize(): SerializedGameObject {
    return {
      ...super.serialize(),
      age: this.age,
      particles: this.particles.map((particle) => ({ ...particle })),
    }
  }
}
