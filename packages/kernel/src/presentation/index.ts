/**
 * Two small pieces every renderer needs, and nothing more.
 *
 * They are in the kernel rather than in an adapter because all three adapters
 * would otherwise carry the same forty lines. What they are *not* is Clockwork
 * 1's `AbstractRenderer`: there is no scene graph here, no drawing, no
 * platform, and above all nothing that writes back to simulation state.
 * `AbstractRenderer.updateNode` read an object's `needsRepaint` flag and then
 * cleared it, which is the renderer mutating the simulation - fine while one
 * frame ran one tick and one view existed, and wrong the moment either of
 * those stopped being true.
 */

/**
 * Keeps one node per item, by id.
 *
 * `sync` is the whole interface: hand it this frame's items and it creates,
 * updates and destroys to match. A renderer using it holds no list of its own
 * and cannot drift out of step with the view.
 */
export class NodeSet<TItem, TNode> {
  private readonly nodes = new Map<string, TNode>()

  constructor(
    private readonly handlers: {
      readonly id: (item: TItem) => string
      readonly create: (item: TItem) => TNode
      readonly update: (node: TNode, item: TItem) => void
      readonly destroy: (node: TNode, id: string) => void
    },
  ) {}

  sync(items: Iterable<TItem>): void {
    const present = new Set<string>()
    for (const item of items) {
      const id = this.handlers.id(item)
      present.add(id)
      let node = this.nodes.get(id)
      if (node === undefined) {
        node = this.handlers.create(item)
        this.nodes.set(id, node)
      }
      this.handlers.update(node, item)
    }
    for (const [id, node] of this.nodes) {
      if (present.has(id)) continue
      this.handlers.destroy(node, id)
      this.nodes.delete(id)
    }
  }

  get(id: string): TNode | undefined {
    return this.nodes.get(id)
  }

  get size(): number {
    return this.nodes.size
  }

  clear(): void {
    for (const [id, node] of this.nodes) this.handlers.destroy(node, id)
    this.nodes.clear()
  }
}

/**
 * Between the last tick's value and this one, at `alpha`.
 *
 * This is what the leftover time in the accumulator is for. A renderer that
 * draws the current tick's position at every frame judders on a display whose
 * rate is not a multiple of the tick rate; one that interpolates does not, and
 * neither of them can change the result.
 */
export function lerp(previous: number, current: number, alpha: number): number {
  return previous + (current - previous) * alpha
}

/** The same, the short way round a circle, for an angle in radians. */
export function lerpAngle(
  previous: number,
  current: number,
  alpha: number,
): number {
  const TWO_PI = 6.283185307179586
  let difference = (current - previous) % TWO_PI
  if (difference > Math.PI) difference -= TWO_PI
  else if (difference < -Math.PI) difference += TWO_PI
  return previous + difference * alpha
}
