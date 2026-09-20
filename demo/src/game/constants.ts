/**
 * The Clockwork 1 demo's numbers, converted.
 *
 * Clockwork 1 ran 60,000 ticks a second, so every timing constant there was
 * milliseconds times 60. Clockwork 2 runs 60 ticks a second, so the conversion
 * is a division by 1,000 and nothing else:
 *
 *   SNAKE_MOVE_INTERVAL   100 ms   6000 ticks  ->    6 ticks
 *   WALL_SPAWN_INTERVAL   500 ms  30000 ticks  ->   30 ticks
 *   APPLE_TIMEOUT      10,000 ms 600000 ticks  ->  600 ticks
 */

export const TICK_HZ = 60

/** Milliseconds to ticks at this game's rate. */
export function ms(milliseconds: number): number {
  return Math.round((milliseconds * TICK_HZ) / 1000)
}

export const GAME_CONFIG = {
  GRID_SIZE: 25,
  CELL_SIZE: 24,
  CANVAS_WIDTH: 600,
  CANVAS_HEIGHT: 600,

  SNAKE_MOVE_INTERVAL: ms(100),
  WALL_SPAWN_INTERVAL: ms(500),
  APPLE_TIMEOUT: ms(10_000),
  APPLE_CLEANUP_INTERVAL: ms(500),

  SNAKE_INITIAL_LENGTH: 2,
  TARGET_APPLES: 50,
  WALL_SIZE: 2,

  EXPLOSION_DURATION: ms(1000),
  EXPLOSION_PARTICLES: 30,

  COLORS: {
    BACKGROUND: 0x1a1a2e,
    GRID: 0x333366,
    SNAKE_HEAD: 0x00ff00,
    SNAKE_BODY: 0x00cc00,
    APPLE: 0xff0000,
    WALL: 0x666666,
    BOMB: 0xff6600,
    EXPLOSION_START: 0xffff00,
    EXPLOSION_MID: 0xff6600,
    EXPLOSION_END: 0x330000,
  },
} as const

export const Direction = {
  UP: "UP",
  DOWN: "DOWN",
  LEFT: "LEFT",
  RIGHT: "RIGHT",
} as const

export type Direction = (typeof Direction)[keyof typeof Direction]

export const DIRECTION_VECTORS: Readonly<
  Record<Direction, { readonly x: number; readonly y: number }>
> = {
  UP: { x: 0, y: -1 },
  DOWN: { x: 0, y: 1 },
  LEFT: { x: -1, y: 0 },
  RIGHT: { x: 1, y: 0 },
}

export const OPPOSITE: Readonly<Record<Direction, Direction>> = {
  UP: "DOWN",
  DOWN: "UP",
  LEFT: "RIGHT",
  RIGHT: "LEFT",
}
