/**
 * A small game for the fixtures that get a data pack wrong.
 *
 * It conforms in every other way, so the only finding a fixture built on it
 * produces is the pack code that fixture is about. `init` reads the start
 * pack `data/rules.json`; `onTick`, when given, runs inside each tick with the
 * reader, which is where a fixture makes its mistake.
 */

import type {
  AssetDeclaration,
  Counters,
  Effect,
  GameModule,
  Manifest,
  PackReader,
  Snapshot,
} from "@clockwork2/engine"
import { fixtureManifest } from "./manifest"

/** `data/rules.json` as the pack fixtures ship it. */
export const RULES: AssetDeclaration = {
  path: "data/rules.json",
  sha256: "09d9a4db066d6e702afcc44a4c6a9f5ec59d76a43498335545ba8a339cf73fdd",
  bytes: 26,
  requiredForSim: true,
  license: "CC0-1.0",
}

/** `data/level.json` as the pack fixtures ship it. */
export const LEVEL: AssetDeclaration = {
  path: "data/level.json",
  sha256: "26113b280d89015f0ef93ebcb5c7f4bb6eff0fb5008fdc3997e7d82bcafa538c",
  bytes: 28,
  requiredForSim: true,
  load: "demand",
  license: "CC0-1.0",
}

export function packManifest(
  id: string,
  assets: readonly AssetDeclaration[],
): Manifest {
  return { ...fixtureManifest(id, 600), assets }
}

export function packGame(
  manifest: Manifest,
  onTick?: (packs: PackReader, tick: number) => void,
): () => GameModule {
  return () => {
    let packs: PackReader
    let step = 0
    let ticks = 0
    return {
      manifest,
      init(_seed: string, _config: unknown, reader: PackReader): void {
        packs = reader
        step = (reader.json(RULES.path) as { step: number }).step
        ticks = 0
      },
      tick(): void {
        onTick?.(packs, ticks)
        ticks++
      },
      view: () => ({ ticks }),
      snapshot: (): Snapshot => ({ ticks, step }),
      restore(snapshot: Snapshot): void {
        ticks = snapshot.ticks as number
        step = snapshot.step as number
      },
      score: (): Counters => ({ score: step, ticksSurvived: ticks }),
      isOver: () => ticks >= 300,
      effects: (): readonly Effect[] => [],
    }
  }
}
