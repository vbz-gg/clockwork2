/**
 * CollisionGrid, from Clockwork 1.
 *
 * An integer lattice, not a spatial index: a map from a whole-number point to
 * whatever is standing on it. That is all a grid game needs, and it is exact,
 * which a float-tolerant broad phase is not. Clockwork 1's README called it a
 * BSP tree; it never was one.
 */

export interface Occupant {
  /** Stable for the lifetime of the thing occupying a cell. */
  readonly id: string
}

function key(x: number, y: number): string {
  return `${x},${y}`
}

export class CollisionGrid<T extends Occupant = Occupant> {
  private readonly cells = new Map<string, T[]>()
  private readonly owned = new Map<string, Set<string>>()

  add(x: number, y: number, occupant: T): void {
    const cell = key(x, y)
    const list = this.cells.get(cell)
    if (list === undefined) this.cells.set(cell, [occupant])
    else if (!list.includes(occupant)) list.push(occupant)

    const cellsOf = this.owned.get(occupant.id) ?? new Set<string>()
    cellsOf.add(cell)
    this.owned.set(occupant.id, cellsOf)
  }

  remove(x: number, y: number, occupant: T): void {
    const cell = key(x, y)
    const list = this.cells.get(cell)
    if (list !== undefined) {
      const at = list.indexOf(occupant)
      if (at >= 0) list.splice(at, 1)
      if (list.length === 0) this.cells.delete(cell)
    }
    this.owned.get(occupant.id)?.delete(cell)
  }

  /** Takes an occupant out of every cell it stands on. */
  removeOccupant(occupant: T): void {
    const cells = this.owned.get(occupant.id)
    if (cells === undefined) return
    for (const cell of cells) {
      const list = this.cells.get(cell)
      if (list === undefined) continue
      const at = list.indexOf(occupant)
      if (at >= 0) list.splice(at, 1)
      if (list.length === 0) this.cells.delete(cell)
    }
    this.owned.delete(occupant.id)
  }

  at(x: number, y: number): readonly T[] {
    return this.cells.get(key(x, y)) ?? []
  }

  occupied(x: number, y: number): boolean {
    const list = this.cells.get(key(x, y))
    return list !== undefined && list.length > 0
  }

  /** How many cells hold something. Useful for a spawn-point search. */
  get size(): number {
    return this.cells.size
  }

  clear(): void {
    this.cells.clear()
    this.owned.clear()
  }
}
