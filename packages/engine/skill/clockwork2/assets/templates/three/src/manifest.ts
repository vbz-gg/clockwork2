/**
 * The manifest: what the platform knows about this game without running it.
 *
 * Everything that decides how a session is run and ranked is here, as
 * data. `assertManifest` from the kernel is the schema - there is no
 * second JSON Schema file to drift from it.
 */

import type { Manifest } from "@clockwork2/engine"

export const MANIFEST: Manifest = {
  schemaVersion: 3,
  /** Immutable across every version of this game. Change it and it is a
   * different game, with a different leaderboard. */
  id: "lane-runner-3d",
  version: "1.0.0",
  name: "Lane Runner 3D",
  kernel: { version: "0.1.0" },
  session: {
    tickHz: 60,
    /** The game ends by itself: a rock hits, or the time limit passes. */
    hasEnding: true,
  },
  inputs: {
    // What the game records: a press left and a press right. Which keys
    // press them is the page's choice, in src/main.ts.
    left: { min: 0, max: 1, label: "Left" },
    right: { min: 0, max: 1, label: "Right" },
  },
  counters: [
    { name: "motes", direction: "up", monotonic: true },
    { name: "ticksSurvived", direction: "up", monotonic: true },
  ],
  rankBy: ["motes", "ticksSurvived"],
  tiePolicy: "shared",
  params: {
    speed: { type: "int", label: "Speed", min: 1, max: 3, default: 1 },
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
    renderer: "three",
    multiplayer: false,
    webgpu: false,
  },
  display: { orientation: "any", minViewport: { width: 320, height: 480 } },
}
