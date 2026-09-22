/**
 * Drawing the game with PIXI 8.
 *
 * Everything here reads. It is handed the view, the view one tick earlier and
 * how far between them this frame sits, and it draws. It never writes to a
 * game object, never clears a repaint flag, and never advances anything -
 * which is what lets the same simulation be drawn twice, or not at all.
 *
 * The snake moves on a grid every six ticks, so interpolating its position
 * would look wrong rather than smooth; `alpha` is used where it helps, on the
 * explosion particles, and ignored where it does not.
 */

import { NodeSet } from "@clockwork2/engine"
import {
  createPixiPresentation,
  type PixiPresentation,
} from "@clockwork2/engine/adapter-pixi"
import { Container, Graphics } from "pixi.js"
import { GAME_CONFIG } from "../game/constants"
import type { SnakeView } from "../game/snake"

const CELL = GAME_CONFIG.CELL_SIZE
const COLORS = GAME_CONFIG.COLORS

function drawGrid(): Graphics {
  const grid = new Graphics()
  const span = GAME_CONFIG.GRID_SIZE * CELL
  for (let i = 0; i <= GAME_CONFIG.GRID_SIZE; i++) {
    grid.moveTo(i * CELL, 0).lineTo(i * CELL, span)
    grid.moveTo(0, i * CELL).lineTo(span, i * CELL)
  }
  grid.stroke({ width: 1, color: COLORS.GRID, alpha: 0.35 })
  return grid
}

export function createSnakePresentation(): PixiPresentation<SnakeView> {
  const world = new Container()
  const segmentLayer = new Container()
  const appleLayer = new Container()
  const wallLayer = new Container()
  const effectLayer = new Container()
  const bomb = new Graphics()

  const segments = new NodeSet<
    { id: string; x: number; y: number; head: boolean },
    Graphics
  >({
    id: (item) => item.id,
    create: (item) => {
      const node = new Graphics()
      segmentLayer.addChild(node)
      void item
      return node
    },
    update: (node, item) => {
      node.clear()
      node
        .roundRect(2, 2, CELL - 4, CELL - 4, item.head ? 7 : 4)
        .fill({ color: item.head ? COLORS.SNAKE_HEAD : COLORS.SNAKE_BODY })
      node.position.set(item.x * CELL, item.y * CELL)
    },
    destroy: (node) => {
      node.destroy()
    },
  })

  const apples = new NodeSet<SnakeView["apples"][number], Graphics>({
    id: (item) => item.id,
    create: () => {
      const node = new Graphics()
      appleLayer.addChild(node)
      return node
    },
    update: (node, item) => {
      node.clear()
      // An apple about to expire shrinks and fades, so the countdown is
      // visible without a number on the screen.
      const remaining = 1 - item.ripeness
      const radius = CELL * 0.3 * (0.6 + 0.4 * remaining)
      node
        .circle(CELL / 2, CELL / 2, radius)
        .fill({ color: COLORS.APPLE, alpha: 0.35 + 0.65 * remaining })
      node.position.set(item.x * CELL, item.y * CELL)
    },
    destroy: (node) => {
      node.destroy()
    },
  })

  const walls = new NodeSet<SnakeView["walls"][number], Graphics>({
    id: (item) => item.id,
    create: () => {
      const node = new Graphics()
      wallLayer.addChild(node)
      return node
    },
    update: (node, item) => {
      node.clear()
      const width = item.horizontal ? CELL * GAME_CONFIG.WALL_SIZE : CELL
      const height = item.horizontal ? CELL : CELL * GAME_CONFIG.WALL_SIZE
      node.rect(1, 1, width - 2, height - 2).fill({ color: COLORS.WALL })
      node.position.set(item.x * CELL, item.y * CELL)
    },
    destroy: (node) => {
      node.destroy()
    },
  })

  const particles = new Graphics()
  effectLayer.addChild(particles)

  return createPixiPresentation<SnakeView>({
    width: GAME_CONFIG.CANVAS_WIDTH,
    height: GAME_CONFIG.CANVAS_HEIGHT,
    background: COLORS.BACKGROUND,
    onReady: (application) => {
      world.addChild(drawGrid())
      world.addChild(wallLayer, appleLayer, bomb, segmentLayer, effectLayer)
      application.stage.addChild(world)
    },
    draw: (_stage, { view, previousView, alpha }) => {
      segments.sync(
        view.segments.map((segment, index) => ({
          id: `s${index}`,
          x: segment.x,
          y: segment.y,
          head: index === 0,
        })),
      )
      apples.sync(view.apples)
      walls.sync(view.walls)

      bomb.clear()
      if (view.bomb !== null) {
        bomb
          .circle(CELL / 2, CELL / 2, CELL * 0.32)
          .fill({ color: COLORS.BOMB })
          .circle(CELL / 2, CELL * 0.18, CELL * 0.08)
          .fill({ color: 0xffdd55 })
        bomb.position.set(view.bomb.x * CELL, view.bomb.y * CELL)
        bomb.visible = true
      } else {
        bomb.visible = false
      }

      particles.clear()
      const explosion = view.explosion
      if (explosion !== null) {
        const previous = previousView?.explosion ?? null
        const colour =
          explosion.progress < 0.35
            ? COLORS.EXPLOSION_START
            : explosion.progress < 0.7
              ? COLORS.EXPLOSION_MID
              : COLORS.EXPLOSION_END
        explosion.particles.forEach((particle, index) => {
          // The particles move every tick, so interpolating them is what
          // `alpha` is for.
          const before = previous?.particles[index] ?? particle
          const x = before.x + (particle.x - before.x) * alpha
          const y = before.y + (particle.y - before.y) * alpha
          particles
            .circle(
              x * CELL + CELL / 2,
              y * CELL + CELL / 2,
              CELL * 0.16 * (1 - explosion.progress),
            )
            .fill({ color: colour, alpha: 1 - explosion.progress })
        })
      }
    },
  })
}
