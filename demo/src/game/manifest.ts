import type { Manifest } from "@clockwork2/engine"
import { GAME_CONFIG, TICK_HZ } from "./constants"

export const MANIFEST: Manifest = {
  schemaVersion: 2,
  id: "clockwork2-snake",
  version: "1.0.0",
  name: "Snake",
  kernel: { version: "0.1.0" },
  session: {
    tickHz: TICK_HZ,
    // Ten minutes. The run ends long before this: walls keep arriving, so a
    // snake that does nothing dies, which is what makes the bound real.
    maxTicks: TICK_HZ * 60 * 10,
    maxWallSeconds: 900,
    hasEnding: true,
  },
  inputs: {
    up: { min: 0, max: 1, label: "Up" },
    down: { min: 0, max: 1, label: "Down" },
    left: { min: 0, max: 1, label: "Left" },
    right: { min: 0, max: 1, label: "Right" },
  },
  counters: [
    { name: "applesEaten", direction: "up", monotonic: true, label: "Apples" },
    { name: "length", direction: "up", monotonic: true, label: "Length" },
    { name: "ticksSurvived", direction: "up", monotonic: true, label: "Ticks" },
  ],
  rankBy: ["applesEaten", "ticksSurvived"],
  tiePolicy: "shared",
  params: {
    bombX: {
      type: "int",
      label: "Bomb column",
      min: 1,
      max: GAME_CONFIG.GRID_SIZE - 2,
      default: 6,
    },
    bombY: {
      type: "int",
      label: "Bomb row",
      min: 1,
      max: GAME_CONFIG.GRID_SIZE - 2,
      default: 6,
    },
    targetApples: {
      type: "int",
      label: "Apples to win",
      min: 1,
      max: 200,
      default: GAME_CONFIG.TARGET_APPLES,
    },
  },
  capabilities: {
    deterministic: true,
    physics: "none",
    renderer: "pixi",
    multiplayer: false,
  },
  display: {
    orientation: "any",
    minViewport: { width: 320, height: 480 },
  },
}
