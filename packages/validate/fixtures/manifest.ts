/** A minimal valid manifest, shared by the fixtures. */
import type { Manifest } from "@clockwork2/kernel"

export function fixtureManifest(id: string, maxTicks = 3600): Manifest {
  return {
    schemaVersion: 1,
    id,
    version: "1.0.0",
    name: id,
    kernel: { version: "0.1.0" },
    session: { tickHz: 60, maxTicks, maxWallSeconds: 120, hasEnding: true },
    inputs: { map: { push: [{ code: "Space", device: "key" }] } },
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
