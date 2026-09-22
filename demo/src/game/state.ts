/**
 * The demo's game state, as plain data.
 *
 * There is no object base class, no group that owns objects, and no hidden
 * update pass. A snake is a record with segments and a direction, an apple is
 * a record with a cell and the tick it appeared, and the functions below are
 * the only things that change them. The game calls each one from its own
 * `tick()`, where a reader can see it happen.
 *
 * Everything here is already a `PlainValue`, so `snapshot()` copies the state
 * rather than converting it, and `restore()` reads it back without a
 * deserialiser per type.
 */

import { dmath, type Prng } from "@clockwork2/engine"
import {
  DIRECTION_VECTORS,
  Direction,
  GAME_CONFIG,
  OPPOSITE,
} from "./constants"

/** A cell on the grid. Integers, both of them. */
export type Point = { readonly x: number; readonly y: number }

export type Snake = {
  /** Head first. */
  segments: Point[]
  direction: Direction
  /** Held until the next move, so two turns in one tick cannot fold it. */
  queued: Direction | null
  /** Set when the bomb goes off, so the explosion can finish playing. */
  frozen: boolean
}

export type Apple = {
  readonly id: string
  readonly at: Point
  /** The tick it appeared, so its age is state rather than a timer. */
  readonly spawnedAt: number
}

export type Wall = {
  readonly id: string
  readonly at: Point
  /** Walls are two cells wide, laid horizontally or vertically. */
  readonly horizontal: boolean
}

export type Particle = { x: number; y: number; vx: number; vy: number }

export type Explosion = {
  particles: Particle[]
  age: number
}

export function samePoint(a: Point, b: Point): boolean {
  return a.x === b.x && a.y === b.y
}

/** The key an occupancy set uses. Exact, because the coordinates are integers. */
export function cellKey(point: Point): string {
  return `${point.x},${point.y}`
}

export function createSnake(start: Point): Snake {
  const segments: Point[] = [start]
  for (let i = 1; i < GAME_CONFIG.SNAKE_INITIAL_LENGTH; i++) {
    segments.push({ x: start.x - i, y: start.y })
  }
  return {
    segments,
    direction: Direction.RIGHT,
    queued: null,
    frozen: false,
  }
}

/** A turn into the neck is ignored, the way it always was. */
export function turnSnake(snake: Snake, direction: Direction): void {
  if (OPPOSITE[direction] === snake.direction) return
  snake.queued = direction
}

/** Where the head lands next, wrapping at the edges. */
export function nextCell(snake: Snake): Point {
  const size = GAME_CONFIG.GRID_SIZE
  const delta = DIRECTION_VECTORS[snake.queued ?? snake.direction]
  const head = snake.segments[0] as Point
  return {
    x: (head.x + delta.x + size) % size,
    y: (head.y + delta.y + size) % size,
  }
}

/** One grid step. The tail stays on when `grow` is set. */
export function moveSnake(snake: Snake, grow: boolean): void {
  if (snake.queued !== null) {
    snake.direction = snake.queued
    snake.queued = null
  }
  snake.segments.unshift(nextCell(snake))
  if (!grow) snake.segments.pop()
}

export function snakeHead(snake: Snake): Point {
  return snake.segments[0] as Point
}

export function snakeOccupies(
  snake: Snake,
  point: Point,
  fromIndex = 0,
): boolean {
  for (let i = fromIndex; i < snake.segments.length; i++) {
    const segment = snake.segments[i] as Point
    if (segment.x === point.x && segment.y === point.y) return true
  }
  return false
}

/** Every cell a wall stands on, wrapping at the edges. */
export function wallCells(wall: Wall): readonly Point[] {
  const size = GAME_CONFIG.GRID_SIZE
  const cells: Point[] = [wall.at]
  for (let i = 1; i < GAME_CONFIG.WALL_SIZE; i++) {
    cells.push(
      wall.horizontal
        ? { x: (wall.at.x + i) % size, y: wall.at.y }
        : { x: wall.at.x, y: (wall.at.y + i) % size },
    )
  }
  return cells
}

/**
 * The particles, drawn from the generator the caller hands over.
 *
 * The generator is a required argument with no fallback, because the explosion
 * decides when the game ends: the run is over once the last particle has
 * played. An effect that looks decorative is still simulation.
 */
export function createExplosion(prng: Prng, at: Point): Explosion {
  const particles: Particle[] = []
  for (let i = 0; i < GAME_CONFIG.EXPLOSION_PARTICLES; i++) {
    const angle = prng.randomFloat(0, 6.283185307179586)
    const speed = prng.randomFloat(0.02, 0.12)
    particles.push({
      x: at.x,
      y: at.y,
      vx: dmath.cos(angle) * speed,
      vy: dmath.sin(angle) * speed,
    })
  }
  return { particles, age: 0 }
}

/** One step. Returns true once the explosion has finished playing. */
export function stepExplosion(explosion: Explosion): boolean {
  explosion.age++
  for (const particle of explosion.particles) {
    particle.x += particle.vx
    particle.y += particle.vy
    particle.vy += 0.002
  }
  return explosion.age >= GAME_CONFIG.EXPLOSION_DURATION
}

/** 0 when it goes off, 1 when it is done. */
export function explosionProgress(explosion: Explosion): number {
  return Math.min(1, explosion.age / GAME_CONFIG.EXPLOSION_DURATION)
}
