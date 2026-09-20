/**
 * Vector2D, from Clockwork 1.
 *
 * Kept because a ported game is full of it, and because the arithmetic is
 * exactly specified so there is nothing to fix. What changed: `x` and `y` are
 * readonly. In Clockwork 1 they were public and mutated in place by game code
 * even though every method returned a new instance, so the same type behaved
 * two ways depending on which line you were reading.
 */

import { dmath } from "@clockwork2/kernel"

export class Vector2D {
  constructor(
    readonly x: number,
    readonly y: number,
  ) {}

  static readonly zero = new Vector2D(0, 0)

  add(other: Vector2D): Vector2D {
    return new Vector2D(this.x + other.x, this.y + other.y)
  }

  subtract(other: Vector2D): Vector2D {
    return new Vector2D(this.x - other.x, this.y - other.y)
  }

  scale(factor: number): Vector2D {
    return new Vector2D(this.x * factor, this.y * factor)
  }

  dot(other: Vector2D): number {
    return this.x * other.x + this.y * other.y
  }

  get length(): number {
    return Math.sqrt(this.x * this.x + this.y * this.y)
  }

  get lengthSquared(): number {
    return this.x * this.x + this.y * this.y
  }

  normalize(): Vector2D {
    const length = this.length
    return length === 0
      ? Vector2D.zero
      : new Vector2D(this.x / length, this.y / length)
  }

  /** Counter-clockwise, in radians. Uses dmath, so it replays anywhere. */
  rotate(radians: number): Vector2D {
    const cos = dmath.cos(radians)
    const sin = dmath.sin(radians)
    return new Vector2D(
      this.x * cos - this.y * sin,
      this.x * sin + this.y * cos,
    )
  }

  get angle(): number {
    return dmath.atan2(this.y, this.x)
  }

  equals(other: Vector2D): boolean {
    return this.x === other.x && this.y === other.y
  }

  clone(): Vector2D {
    return new Vector2D(this.x, this.y)
  }

  toString(): string {
    return `(${this.x}, ${this.y})`
  }

  /** Plain data, so it goes straight into a snapshot. */
  serialize(): { readonly x: number; readonly y: number } {
    return { x: this.x, y: this.y }
  }

  static deserialize(data: {
    readonly x: number
    readonly y: number
  }): Vector2D {
    return new Vector2D(data.x, data.y)
  }

  static distance(a: Vector2D, b: Vector2D): number {
    return dmath.hypot(a.x - b.x, a.y - b.y)
  }

  static distanceSquared(a: Vector2D, b: Vector2D): number {
    const dx = a.x - b.x
    const dy = a.y - b.y
    return dx * dx + dy * dy
  }

  static isWithinDistance(a: Vector2D, b: Vector2D, distance: number): boolean {
    return Vector2D.distanceSquared(a, b) <= distance * distance
  }

  /** Into [-pi, pi). */
  static normalizeAngle(radians: number): number {
    return dmath.wrapAngle(radians)
  }

  /** The short way from one angle to another. */
  static angleDifference(from: number, to: number): number {
    return dmath.wrapAngle(to - from)
  }
}
