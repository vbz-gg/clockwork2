/**
 * Deliberately non-conformant: a counter declared monotonic goes backwards.
 *
 * `score` is declared `direction: "up", monotonic: true`, and this game spends
 * it. A platform that ranks on a counter it was told only ever rises, and then
 * sees it fall, has no basis for the leaderboard it already published.
 */

import type { Counters, Effect, GameModule, Snapshot } from "@clockwork2/engine"
import { fixtureManifest } from "../manifest"

export class CounterReversedGame implements GameModule {
  readonly manifest = fixtureManifest("counter-reversed", 600)
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
    // Climbs to 10 and then pays some back, which "up" and "monotonic" forbid.
    return {
      score: this.ticks <= 10 ? this.ticks : 20 - this.ticks,
      ticksSurvived: this.ticks,
    }
  }
  isOver(): boolean {
    return this.ticks >= 300
  }
  effects(): readonly Effect[] {
    return []
  }
}

export default function createGame(): CounterReversedGame {
  return new CounterReversedGame()
}
