/**
 * The geometry helpers from Clockwork 1, on dmath.
 *
 * They were already pure functions over exactly specified arithmetic, apart
 * from the angle blending, which called Math.atan2 and now calls dmath.atan2.
 */

import { dmath } from "@clockwork2/kernel"
import { Vector2D } from "./vector"

export interface Rectangle {
  readonly x: number
  readonly y: number
  readonly width: number
  readonly height: number
}

export function rectanglesOverlap(a: Rectangle, b: Rectangle): boolean {
  return (
    a.x < b.x + b.width &&
    a.x + a.width > b.x &&
    a.y < b.y + b.height &&
    a.y + a.height > b.y
  )
}

/** A forgiving hit test: a circle against a box. */
export function circleOverlapsRectangle(
  centre: Vector2D,
  radius: number,
  rectangle: Rectangle,
): boolean {
  const closestX = Math.max(
    rectangle.x,
    Math.min(centre.x, rectangle.x + rectangle.width),
  )
  const closestY = Math.max(
    rectangle.y,
    Math.min(centre.y, rectangle.y + rectangle.height),
  )
  const dx = centre.x - closestX
  const dy = centre.y - closestY
  return dx * dx + dy * dy <= radius * radius
}

export function linesIntersect(
  a1: Vector2D,
  a2: Vector2D,
  b1: Vector2D,
  b2: Vector2D,
): boolean {
  const d = (a2.x - a1.x) * (b2.y - b1.y) - (a2.y - a1.y) * (b2.x - b1.x)
  if (d === 0) return false
  const u = ((b1.x - a1.x) * (b2.y - b1.y) - (b1.y - a1.y) * (b2.x - b1.x)) / d
  const v = ((b1.x - a1.x) * (a2.y - a1.y) - (b1.y - a1.y) * (a2.x - a1.x)) / d
  return u >= 0 && u <= 1 && v >= 0 && v <= 1
}

export function lineIntersectsRectangle(
  from: Vector2D,
  to: Vector2D,
  rectangle: Rectangle,
): boolean {
  const corners = [
    new Vector2D(rectangle.x, rectangle.y),
    new Vector2D(rectangle.x + rectangle.width, rectangle.y),
    new Vector2D(rectangle.x + rectangle.width, rectangle.y + rectangle.height),
    new Vector2D(rectangle.x, rectangle.y + rectangle.height),
  ]
  for (let i = 0; i < 4; i++) {
    if (
      linesIntersect(
        from,
        to,
        corners[i] as Vector2D,
        corners[(i + 1) % 4] as Vector2D,
      )
    ) {
      return true
    }
  }
  return false
}

/** Turns `from` towards `to` by at most `maxRadians`. */
export function turnTowards(
  from: number,
  to: number,
  maxRadians: number,
): number {
  const difference = dmath.wrapAngle(to - from)
  const step = Math.max(-maxRadians, Math.min(maxRadians, difference))
  return dmath.wrapAngle(from + step)
}

/** Where something travelling at `velocity` will be after `ticks`. */
export function futurePosition(
  position: Vector2D,
  velocity: Vector2D,
  ticks: number,
): Vector2D {
  return position.add(velocity.scale(ticks))
}
