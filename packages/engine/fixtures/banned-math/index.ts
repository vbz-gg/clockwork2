/** Deliberately non-conformant: uses Math.random and Math.sin in the simulation. */
import type { Counters, Effect, GameModule, Snapshot } from "@clockwork2/engine"
import { fixtureManifest } from "../manifest"

export class BadGame implements GameModule {
  readonly manifest = fixtureManifest("banned-math")
  private ticks = 0
  private value = 0
  init(): void {
    this.ticks = 0
    this.value = 0
  }
  tick(): void {
    this.value += Math.random() + Math.sin(this.value)
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
    return {
      score: Math.max(0, Math.floor(this.value)),
      ticksSurvived: this.ticks,
    }
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
