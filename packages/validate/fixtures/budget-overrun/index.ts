/**
 * Deliberately non-conformant: every way an asset declaration can be wrong.
 *
 * The game itself conforms. What fails is the manifest's account of the bundle,
 * in all four ways the budgets check knows about at once: a file declared and
 * not shipped, a file whose bytes do not hash to what was declared, a file
 * whose length is not what was declared, and a total over the budget. A
 * platform that accepts any of these is serving a bundle it cannot vouch for.
 */

import type {
  Counters,
  Effect,
  GameModule,
  Manifest,
  Snapshot,
} from "@clockwork2/kernel"
import { fixtureManifest } from "../manifest"

const base = fixtureManifest("budget-overrun", 600)

export const MANIFEST: Manifest = {
  ...base,
  assets: [
    {
      // Shipped, hashes correctly, and 38 bytes rather than the 99 declared.
      path: "data/layout.txt",
      sha256:
        "c0183e3b58cd90258d91704d099d024cae282ded1a05db26d2bf0647d3250ec3",
      bytes: 99,
      requiredForSim: true,
      license: "CC0-1.0",
    },
    {
      // Shipped and 34 bytes, but the digest is not this file's.
      path: "data/texture.txt",
      sha256: "0".repeat(64),
      bytes: 34,
      requiredForSim: false,
      license: "CC0-1.0",
    },
    {
      // Declared and never shipped.
      path: "data/missing.txt",
      sha256: "1".repeat(64),
      bytes: 12,
      requiredForSim: true,
      license: "CC0-1.0",
    },
  ],
  // The two files that are present come to 72 bytes between them.
  budgets: { assetBytes: 1 },
}

export class BudgetOverrunGame implements GameModule {
  readonly manifest = MANIFEST
  private ticks = 0
  init(): void {
    this.ticks = 0
  }
  tick(): void {
    this.ticks++
  }
  view(): unknown {
    return { ticks: this.ticks }
  }
  snapshot(): Snapshot {
    return { ticks: this.ticks }
  }
  restore(snapshot: Snapshot): void {
    this.ticks = snapshot.ticks as number
  }
  score(): Counters {
    return { score: 0, ticksSurvived: this.ticks }
  }
  isOver(): boolean {
    return this.ticks >= 300
  }
  effects(): readonly Effect[] {
    return []
  }
}

export default function createGame(): BudgetOverrunGame {
  return new BudgetOverrunGame()
}
