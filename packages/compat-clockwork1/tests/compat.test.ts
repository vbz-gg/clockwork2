import { describe, expect, test } from "bun:test"
import { dmath, toBitsHex } from "@clockwork2/kernel"
import {
  CollisionGrid,
  circleOverlapsRectangle,
  GameObject,
  GameObjectGroup,
  lineIntersectsRectangle,
  rectanglesOverlap,
  turnTowards,
  Vector2D,
} from "../src/index"

class Thing extends GameObject {
  extra = 0
  getType(): string {
    return "thing"
  }
}

describe("Vector2D", () => {
  test("arithmetic returns new vectors and leaves the old ones alone", () => {
    const a = new Vector2D(1, 2)
    const b = new Vector2D(3, 4)
    expect(a.add(b)).toEqual(new Vector2D(4, 6))
    expect(a.subtract(b)).toEqual(new Vector2D(-2, -2))
    expect(a.scale(2)).toEqual(new Vector2D(2, 4))
    expect(a).toEqual(new Vector2D(1, 2))
  })

  test("length, normalize and dot", () => {
    expect(new Vector2D(3, 4).length).toBe(5)
    expect(new Vector2D(3, 4).lengthSquared).toBe(25)
    expect(new Vector2D(3, 4).normalize().length).toBeCloseTo(1, 12)
    expect(Vector2D.zero.normalize()).toEqual(Vector2D.zero)
    expect(new Vector2D(1, 2).dot(new Vector2D(3, 4))).toBe(11)
  })

  test("rotation goes through dmath, so it replays anywhere", () => {
    const rotated = new Vector2D(1, 0).rotate(dmath.PI_2)
    expect(toBitsHex(rotated.x)).toBe(toBitsHex(dmath.cos(dmath.PI_2)))
    expect(toBitsHex(rotated.y)).toBe(toBitsHex(dmath.sin(dmath.PI_2)))
    // And the same rotation twice gives exactly the same bits.
    const again = new Vector2D(1, 0).rotate(dmath.PI_2)
    expect(toBitsHex(again.x)).toBe(toBitsHex(rotated.x))
  })

  test("round trips through a snapshot", () => {
    const original = new Vector2D(1.5, -2.25)
    const restored = Vector2D.deserialize(
      JSON.parse(JSON.stringify(original.serialize())) as {
        x: number
        y: number
      },
    )
    expect(restored).toEqual(original)
  })

  test("distance helpers", () => {
    const a = new Vector2D(0, 0)
    const b = new Vector2D(3, 4)
    expect(Vector2D.distance(a, b)).toBe(5)
    expect(Vector2D.distanceSquared(a, b)).toBe(25)
    expect(Vector2D.isWithinDistance(a, b, 5)).toBe(true)
    expect(Vector2D.isWithinDistance(a, b, 4.9)).toBe(false)
  })

  test("angle differences take the short way round", () => {
    // From 3 to -3 is a short step forwards across the wrap, not six radians
    // backwards.
    expect(Vector2D.angleDifference(3, -3)).toBeCloseTo(2 * Math.PI - 6, 10)
    expect(Vector2D.angleDifference(-3, 3)).toBeCloseTo(6 - 2 * Math.PI, 10)
    expect(Vector2D.normalizeAngle(7)).toBeLessThan(Math.PI)
    expect(Vector2D.normalizeAngle(7)).toBeGreaterThanOrEqual(-Math.PI)
  })
})

describe("CollisionGrid", () => {
  test("tracks what stands where", () => {
    const grid = new CollisionGrid()
    const a = { id: "a" }
    grid.add(2, 3, a)
    expect(grid.occupied(2, 3)).toBe(true)
    expect(grid.at(2, 3)).toEqual([a])
    expect(grid.occupied(3, 2)).toBe(false)
    grid.remove(2, 3, a)
    expect(grid.occupied(2, 3)).toBe(false)
    expect(grid.size).toBe(0)
  })

  test("one occupant can stand on many cells and leave them all at once", () => {
    const grid = new CollisionGrid()
    const snake = { id: "snake" }
    for (let x = 0; x < 5; x++) grid.add(x, 0, snake)
    expect(grid.size).toBe(5)
    grid.removeOccupant(snake)
    expect(grid.size).toBe(0)
  })

  test("adding twice does not duplicate", () => {
    const grid = new CollisionGrid()
    const a = { id: "a" }
    grid.add(1, 1, a)
    grid.add(1, 1, a)
    expect(grid.at(1, 1).length).toBe(1)
  })

  test("negative coordinates are distinct from positive ones", () => {
    const grid = new CollisionGrid()
    grid.add(-1, -1, { id: "a" })
    expect(grid.occupied(-1, -1)).toBe(true)
    expect(grid.occupied(1, 1)).toBe(false)
  })
})

describe("GameObject", () => {
  test("nothing registers itself anywhere", () => {
    // Clockwork 1's constructor called engine.registerGameObject(this), which
    // made building an object a global side effect.
    const thing = new Thing("t1", new Vector2D(0, 0))
    expect(thing.id).toBe("t1")
    expect(thing.destroyed).toBe(false)
  })

  test("update moves by velocity, once, with no delta", () => {
    const thing = new Thing("t1", new Vector2D(0, 0))
    thing.velocity = new Vector2D(2, -1)
    thing.update()
    expect(thing.position).toEqual(new Vector2D(2, -1))
    thing.update()
    expect(thing.position).toEqual(new Vector2D(4, -2))
  })

  test("a still object does not ask to be repainted", () => {
    const thing = new Thing("t1", new Vector2D(0, 0))
    thing.needsRepaint = false
    thing.update()
    expect(thing.needsRepaint).toBe(false)
    thing.velocity = new Vector2D(1, 0)
    thing.update()
    expect(thing.needsRepaint).toBe(true)
  })

  test("losing all health destroys it", () => {
    const thing = new Thing("t1", new Vector2D(0, 0), Vector2D.zero, 3)
    thing.takeDamage(1)
    expect(thing.destroyed).toBe(false)
    thing.takeDamage(5)
    expect(thing.health).toBe(0)
    expect(thing.destroyed).toBe(true)
  })

  test("serialize carries the id and the type", () => {
    // Clockwork 1's left both out while every subclass's deserialize read
    // data.id, so the round trip was broken for the base shape.
    const thing = new Thing("t1", new Vector2D(1, 2), new Vector2D(3, 4), 5)
    const data = thing.serialize()
    expect(data.id).toBe("t1")
    expect(data.type).toBe("thing")
    const restored = new Thing("t1", Vector2D.zero)
    restored.restoreBase(JSON.parse(JSON.stringify(data)))
    expect(restored.position).toEqual(thing.position)
    expect(restored.health).toBe(5)
  })
})

describe("GameObjectGroup", () => {
  test("the game drives the update pass, and nothing else does", () => {
    // The hidden pass is what let two games step every object twice per tick
    // and be tuned that way.
    const group = new GameObjectGroup<Thing>("thing")
    const a = group.add(new Thing("a", Vector2D.zero))
    a.velocity = new Vector2D(1, 0)
    expect(a.position.x).toBe(0)
    group.update()
    expect(a.position.x).toBe(1)
  })

  test("iterates in insertion order", () => {
    const group = new GameObjectGroup<Thing>("thing")
    for (const id of ["c", "a", "b"]) group.add(new Thing(id, Vector2D.zero))
    expect(group.all().map((t) => t.id)).toEqual(["c", "a", "b"])
  })

  test("destroyed objects stop updating and can be cleared", () => {
    const group = new GameObjectGroup<Thing>("thing")
    const a = group.add(new Thing("a", Vector2D.zero))
    a.velocity = new Vector2D(1, 0)
    a.destroy()
    group.update()
    expect(a.position.x).toBe(0)
    expect(group.active().length).toBe(0)
    expect(group.clearDestroyed()).toBe(1)
    expect(group.size).toBe(0)
  })

  test("restores from a snapshot in the recorded order", () => {
    const group = new GameObjectGroup<Thing>("thing")
    for (const id of ["z", "y", "x"]) {
      const thing = group.add(new Thing(id, new Vector2D(1, 1)))
      thing.extra = id.charCodeAt(0)
    }
    const data = JSON.parse(JSON.stringify(group.serialize()))

    const restored = new GameObjectGroup<Thing>("thing")
    restored.restore(data, (record) => {
      const thing = new Thing(record.id, Vector2D.zero)
      thing.restoreBase(record)
      return thing
    })
    expect(restored.all().map((t) => t.id)).toEqual(["z", "y", "x"])
    expect(restored.get("y")?.position).toEqual(new Vector2D(1, 1))
  })
})

describe("geometry", () => {
  test("rectangles", () => {
    const a = { x: 0, y: 0, width: 10, height: 10 }
    expect(rectanglesOverlap(a, { x: 5, y: 5, width: 10, height: 10 })).toBe(
      true,
    )
    expect(rectanglesOverlap(a, { x: 10, y: 0, width: 10, height: 10 })).toBe(
      false,
    )
  })

  test("a circle against a box is forgiving in the corners", () => {
    const box = { x: 0, y: 0, width: 10, height: 10 }
    expect(circleOverlapsRectangle(new Vector2D(5, 5), 1, box)).toBe(true)
    expect(circleOverlapsRectangle(new Vector2D(-2, -2), 1, box)).toBe(false)
    expect(circleOverlapsRectangle(new Vector2D(-1, -1), 2, box)).toBe(true)
  })

  test("a line against a box", () => {
    const box = { x: 0, y: 0, width: 10, height: 10 }
    expect(
      lineIntersectsRectangle(new Vector2D(-5, 5), new Vector2D(15, 5), box),
    ).toBe(true)
    expect(
      lineIntersectsRectangle(new Vector2D(-5, -5), new Vector2D(-1, -1), box),
    ).toBe(false)
  })

  test("turning takes the short way and stops at the target", () => {
    expect(turnTowards(0, 0.1, 1)).toBeCloseTo(0.1, 12)
    expect(turnTowards(0, 3, 0.5)).toBeCloseTo(0.5, 12)
    expect(turnTowards(0, -3, 0.5)).toBeCloseTo(-0.5, 12)
    // Across the wrap the short way is forwards and is under half a radian,
    // so one step arrives rather than overshooting the long way round.
    expect(turnTowards(3, -3, 0.5)).toBeCloseTo(-3, 10)
  })
})
