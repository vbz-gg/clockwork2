/** A minimal valid manifest, shared by the fixtures. */
import type { Manifest } from "@clockwork2/engine"

export function fixtureManifest(id: string): Manifest {
  return {
    schemaVersion: 3,
    id,
    version: "1.0.0",
    name: id,
    kernel: { version: "0.1.0" },
    session: { tickHz: 60, hasEnding: true },
    inputs: { push: { min: 0, max: 1 } },
    counters: [
      { name: "score", direction: "up", monotonic: true },
      { name: "ticksSurvived", direction: "up", monotonic: true },
    ],
    rankBy: ["score"],
    tiePolicy: "shared",
    capabilities: {
      deterministic: true,
      physics: "none",
      renderer: "canvas2d",
      multiplayer: false,
    },
  }
}
