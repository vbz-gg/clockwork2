/**
 * Deliberately non-conformant for a ranked run: the game never reads its
 * seed, so every seed plays the same game. Every check a game needs passes,
 * because determinism compares runs of one seed; the seed check refuses it.
 */
import type {
  Counters,
  Effect,
  GameModule,
  InputEvent,
  Snapshot,
} from "@clockwork2/engine"
import { fixtureManifest } from "../manifest"

export class SeedBlindGame implements GameModule {
  readonly manifest = fixtureManifest("seed-ignored")
  private value = 0
  private ticks = 0
  init(): void {
    this.value = 0
    this.ticks = 0
  }
  tick(inputs: readonly InputEvent[]): void {
    for (const input of inputs) {
      if (input.code === "push" && input.value > 0) this.value += 1
    }
    if (this.ticks % 30 === 0) this.value += 2
    this.ticks++
  }
  view(): unknown {
    return { value: this.value }
  }
  snapshot(): Snapshot {
    return { value: this.value, ticks: this.ticks }
  }
  restore(snapshot: Snapshot): void {
    this.value = snapshot.value as number
    this.ticks = snapshot.ticks as number
  }
  score(): Counters {
    return { score: this.value, ticksSurvived: this.ticks }
  }
  isOver(): boolean {
    return this.ticks >= 1800
  }
  effects(): readonly Effect[] {
    return []
  }
}

export default function createGame(): SeedBlindGame {
  return new SeedBlindGame()
}
