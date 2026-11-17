/**
 * A conforming game whose seed shapes play and whose end does not show it.
 *
 * For its first 600 ticks a seeded generator moves a marker about; then the
 * marker comes home and the generator is put away. Every run ends at tick 900
 * in the same state with the same counters whatever its seed, so a seed check
 * that compared only where a run ended would call it seed-blind. Its
 * checkpoints before tick 600 differ by seed, which is the seed changing the
 * game.
 */
import {
  type Counters,
  type Effect,
  type GameModule,
  Prng,
  type PrngState,
  type Snapshot,
} from "@clockwork2/engine"
import { fixtureManifest } from "../manifest"

/** The tick the marker comes home and the generator is put away. */
export const SETTLES_AT = 600
/** The tick every run ends. */
export const ENDS_AT = 900

export class SeedConvergesGame implements GameModule {
  readonly manifest = fixtureManifest("seed-converges")
  private rng: Prng | null = null
  private marker = 0
  private ticks = 0

  init(seed: string): void {
    this.rng = new Prng(seed)
    this.marker = 0
    this.ticks = 0
  }

  tick(): void {
    if (this.ticks < SETTLES_AT) {
      this.marker = this.rng?.randomInt(0, 9) ?? 0
    } else if (this.rng !== null) {
      this.marker = 0
      this.rng = null
    }
    this.ticks++
  }

  view(): unknown {
    return { marker: this.marker }
  }

  snapshot(): Snapshot {
    return {
      marker: this.marker,
      ticks: this.ticks,
      rng:
        this.rng === null
          ? null
          : (this.rng.exportState() as unknown as Snapshot),
    }
  }

  restore(snapshot: Snapshot): void {
    this.marker = snapshot.marker as number
    this.ticks = snapshot.ticks as number
    const rng = snapshot.rng as unknown as PrngState | null
    if (rng === null) {
      this.rng = null
    } else {
      this.rng = new Prng("restored")
      this.rng.importState(rng)
    }
  }

  score(): Counters {
    return { score: 0, ticksSurvived: this.ticks }
  }

  isOver(): boolean {
    return this.ticks >= ENDS_AT
  }

  effects(): readonly Effect[] {
    return []
  }
}

export default function createGame(): SeedConvergesGame {
  return new SeedConvergesGame()
}
