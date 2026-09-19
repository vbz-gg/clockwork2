/**
 * Deliberately non-conformant: the snapshot leaves out the PRNG position, so
 * restoring gives back the game state and then draws a different number on the
 * very next tick.
 *
 * This is the failure `restore` exists to find, and it is invisible to every
 * other check: the game is perfectly deterministic from a cold start.
 */
import {
  type Counters,
  type Effect,
  type GameModule,
  Prng,
  type Snapshot,
} from "@clockwork2/kernel"
import { fixtureManifest } from "../manifest"

export class BadGame implements GameModule {
  readonly manifest = fixtureManifest("incomplete-snapshot")
  private rng!: Prng
  private ticks = 0
  private value = 0

  init(seed: string): void {
    this.rng = new Prng(seed)
    this.ticks = 0
    this.value = 0
  }
  tick(): void {
    this.value += this.rng.randomInt(0, 4)
    this.ticks++
  }
  view(): unknown {
    return { value: this.value }
  }
  snapshot(): Snapshot {
    // The generator's position is missing.
    return { ticks: this.ticks, value: this.value }
  }
  restore(snapshot: Snapshot): void {
    this.ticks = snapshot.ticks as number
    this.value = snapshot.value as number
  }
  score(): Counters {
    return { score: this.value, ticksSurvived: this.ticks }
  }
  isOver(): boolean {
    return this.ticks >= 600
  }
  effects(): readonly Effect[] {
    return []
  }
}

export default function createGame(): BadGame {
  return new BadGame()
}
