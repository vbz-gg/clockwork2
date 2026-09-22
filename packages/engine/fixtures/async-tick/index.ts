/** Deliberately non-conformant: an asynchronous tick. */
import type { Counters, Effect, GameModule, Snapshot } from "@clockwork2/engine"
import { fixtureManifest } from "../manifest"

export class BadGame implements GameModule {
  readonly manifest = fixtureManifest("async-tick")
  private ticks = 0
  init(): void {
    this.ticks = 0
    // nothing
  }
  async tick(): Promise<void> {
    await Promise.resolve()
    this.ticks++
  }
  view(): unknown {
    return {}
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
    return this.ticks >= 600
  }
  effects(): readonly Effect[] {
    return []
  }
}

export default function createGame(): BadGame {
  return new BadGame()
}
