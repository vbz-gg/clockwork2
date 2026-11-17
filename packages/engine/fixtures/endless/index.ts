/**
 * A game that never ends. It conforms: no run has a step limit, so every check
 * plays it to the check window and passes, and the report says each run was
 * still going when the window closed.
 */
import type { Counters, Effect, GameModule, Snapshot } from "@clockwork2/engine"
import { fixtureManifest } from "../manifest"

export class EndlessGame implements GameModule {
  readonly manifest = {
    ...fixtureManifest("endless"),
    session: { tickHz: 60, hasEnding: false },
  } as const
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
    return false
  }
  effects(): readonly Effect[] {
    return []
  }
}

export default function createGame(): EndlessGame {
  return new EndlessGame()
}
