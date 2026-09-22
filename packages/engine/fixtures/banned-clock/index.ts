/** Deliberately non-conformant: reads the wall clock and a host timer. */
import type { Counters, Effect, GameModule, Snapshot } from "@clockwork2/engine"
import { fixtureManifest } from "../manifest"

export class BadGame implements GameModule {
  readonly manifest = fixtureManifest("banned-clock")
  private ticks = 0
  private startedAt = 0
  init(): void {
    this.ticks = 0
    this.startedAt = Date.now()
    setTimeout(() => undefined, 16)
  }
  tick(): void {
    if (performance.now() - this.startedAt > 1000) this.startedAt = Date.now()
    this.ticks++
  }
  view(): unknown {
    return {}
  }
  snapshot(): Snapshot {
    return { startedAt: this.startedAt, ticks: this.ticks }
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
