/** Deliberately non-conformant: uses the exponent operator and Math.pow. */
import type { Counters, Effect, GameModule, Snapshot } from "@clockwork2/engine"
import { fixtureManifest } from "../manifest"

export class BadGame implements GameModule {
  readonly manifest = fixtureManifest("banned-pow")
  private ticks = 0
  private value = 1
  init(): void {
    this.ticks = 0
    this.value = 1
  }
  tick(): void {
    this.value = Math.pow(this.value, 1.0001) + this.value ** 2
    this.ticks++
  }
  view(): unknown {
    return {}
  }
  snapshot(): Snapshot {
    return { value: this.value, ticks: this.ticks }
  }
  restore(snapshot: Snapshot): void {
    this.ticks = snapshot.ticks as number
  }
  score(): Counters {
    return { score: 0, ticksSurvived: this.ticks }
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
