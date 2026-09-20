/**
 * The manifest: what the platform knows about this game without running it.
 *
 * Everything that decides how a session is run, ranked and bounded is here,
 * as data. `assertManifest` from the kernel is the schema - there is no
 * second JSON Schema file to drift from it.
 */

import type { Manifest } from "@clockwork2/kernel"

export const MANIFEST: Manifest = {
  schemaVersion: 1,
  /** Immutable across every version of this game. Change it and it is a
   * different game, with a different leaderboard. */
  id: "lane-runner",
  version: "1.0.0",
  name: "Lane Runner",
  kernel: { version: "0.1.0" },
  session: {
    tickHz: 60,
    /** The hard cap. The kernel ends the run here whatever the game says. */
    maxTicks: 60 * 120,
    maxWallSeconds: 300,
    hasEnding: true,
  },
  inputs: {
    map: {
      left: [
        { code: "ArrowLeft", device: "key", label: "Left" },
        { code: "KeyA", device: "key" },
      ],
      right: [
        { code: "ArrowRight", device: "key", label: "Right" },
        { code: "KeyD", device: "key" },
      ],
    },
    virtualControls: [
      { id: "left", kind: "button", label: "Left", action: "left" },
      { id: "right", kind: "button", label: "Right", action: "right" },
    ],
  },
  counters: [
    { name: "motes", direction: "up", monotonic: true },
    { name: "ticksSurvived", direction: "up", monotonic: true },
  ],
  rankBy: ["motes", "ticksSurvived"],
  tiePolicy: "shared",
  params: {
    speed: {
      type: "int",
      label: "Speed",
      min: 1,
      max: 3,
      default: 1,
    },
    startingLane: {
      type: "int",
      label: "Starting lane",
      min: 0,
      max: 2,
      default: 1,
    },
  },
  capabilities: {
    deterministic: true,
    physics: "none",
    renderer: "canvas2d",
    multiplayer: false,
  },
  display: { orientation: "any", minViewport: { width: 320, height: 480 } },
}
