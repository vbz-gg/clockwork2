/**
 * GameObject and GameObjectGroup, from Clockwork 1, with three changes that
 * are the reason this is a compatibility package rather than a copy.
 *
 * **Nothing registers itself.** Clockwork 1's constructor called
 * `engine.registerGameObject(this)`, so building an object had a global side
 * effect and construction order was part of the determinism contract without
 * anyone saying so. Here a game adds an object to a group it owns.
 *
 * **There is no hidden update pass.** The engine used to walk every registered
 * group after every update. A game could not see that happening and could not
 * stop it, which is how tiki-kong and tiki-jump ended up stepping every object
 * twice per tick and being tuned that way. Here the game calls `group.update()`
 * from its own `tick()`, once, where it can be read.
 *
 * **`serialize()` includes the id and the type.** Clockwork 1's left both out
 * while every subclass's `deserialize` read `data.id`, so the round trip was
 * broken for the base shape.
 */

import type { PlainValue } from "@clockwork2/kernel"
import { Vector2D } from "./vector"

export interface SerializedGameObject {
  readonly id: string
  readonly type: string
  readonly position: { readonly x: number; readonly y: number }
  readonly size: { readonly x: number; readonly y: number }
  readonly velocity: { readonly x: number; readonly y: number }
  readonly rotation: number
  readonly health: number
  readonly maxHealth: number
  readonly destroyed: boolean
  readonly [key: string]: PlainValue
}

export abstract class GameObject {
  position: Vector2D
  size: Vector2D
  velocity: Vector2D = Vector2D.zero
  rotation = 0
  health: number
  maxHealth: number
  destroyed = false

  /**
   * A hint for a renderer that something changed.
   *
   * The renderer reads it and never clears it. Clockwork 1's `AbstractRenderer`
   * cleared it, which made drawing a write to simulation state - fine while
   * one frame ran one tick and one view existed, wrong as soon as either
   * stopped being true.
   */
  needsRepaint = true

  constructor(
    readonly id: string,
    position: Vector2D,
    size: Vector2D = Vector2D.zero,
    health = 1,
  ) {
    this.position = position
    this.size = size
    this.health = health
    this.maxHealth = health
  }

  abstract getType(): string

  /** One fixed step. No delta, because there is no delta. */
  update(): void {
    if (this.velocity.x !== 0 || this.velocity.y !== 0) {
      this.position = this.position.add(this.velocity)
      this.needsRepaint = true
    }
  }

  setPosition(position: Vector2D): void {
    if (this.position.equals(position)) return
    this.position = position
    this.needsRepaint = true
  }

  takeDamage(amount: number): void {
    this.setHealth(this.health - amount)
  }

  setHealth(value: number): void {
    const next = Math.max(0, value)
    if (next === this.health) return
    this.health = next
    this.needsRepaint = true
    if (next === 0) this.destroy()
  }

  destroy(): void {
    if (this.destroyed) return
    this.destroyed = true
    this.needsRepaint = true
  }

  /** The centre, for a hit test that works from the middle out. */
  get centre(): Vector2D {
    return new Vector2D(
      this.position.x + this.size.x / 2,
      this.position.y + this.size.y / 2,
    )
  }

  serialize(): SerializedGameObject {
    return {
      id: this.id,
      type: this.getType(),
      position: this.position.serialize(),
      size: this.size.serialize(),
      velocity: this.velocity.serialize(),
      rotation: this.rotation,
      health: this.health,
      maxHealth: this.maxHealth,
      destroyed: this.destroyed,
    }
  }

  /** Puts the base fields back. A subclass restores its own on top. */
  restoreBase(data: SerializedGameObject): void {
    this.position = Vector2D.deserialize(data.position)
    this.size = Vector2D.deserialize(data.size)
    this.velocity = Vector2D.deserialize(data.velocity)
    this.rotation = data.rotation
    this.health = data.health
    this.maxHealth = data.maxHealth
    this.destroyed = data.destroyed
    this.needsRepaint = true
  }
}

/**
 * A set of objects of one type, in insertion order.
 *
 * Insertion order is the iteration order, and it is deterministic because the
 * insertion history is. Do not sort here to make it "safe": sorting would hide
 * an ordering bug rather than prevent one.
 */
export class GameObjectGroup<T extends GameObject> {
  private readonly items = new Map<string, T>()

  constructor(readonly type: string) {}

  add(item: T): T {
    this.items.set(item.id, item)
    return item
  }

  remove(item: T | string): boolean {
    return this.items.delete(typeof item === "string" ? item : item.id)
  }

  get(id: string): T | undefined {
    return this.items.get(id)
  }

  has(id: string): boolean {
    return this.items.has(id)
  }

  get size(): number {
    return this.items.size
  }

  /** Everything, destroyed or not, in insertion order. */
  all(): readonly T[] {
    return [...this.items.values()]
  }

  /** Only what is still alive. Allocates, so call it once per tick. */
  active(): readonly T[] {
    const out: T[] = []
    for (const item of this.items.values()) if (!item.destroyed) out.push(item)
    return out
  }

  /** Steps every living object once. The game calls this; nothing else does. */
  update(): void {
    for (const item of this.items.values()) {
      if (!item.destroyed) item.update()
    }
  }

  /** Drops what was destroyed. Call it at a point of your choosing. */
  clearDestroyed(): number {
    let removed = 0
    for (const [id, item] of this.items) {
      if (!item.destroyed) continue
      this.items.delete(id)
      removed++
    }
    return removed
  }

  clear(): void {
    this.items.clear()
  }

  serialize(): readonly SerializedGameObject[] {
    return this.all().map((item) => item.serialize())
  }

  /**
   * Rebuilds the group from a snapshot.
   *
   * The factory is the game's, because only the game knows how to build its
   * own objects. Order is the order in the snapshot, which is the order they
   * were inserted, so a restored group iterates exactly as the original did.
   */
  restore(
    data: readonly SerializedGameObject[],
    factory: (record: SerializedGameObject) => T,
  ): void {
    this.items.clear()
    for (const record of data) this.add(factory(record))
  }
}
