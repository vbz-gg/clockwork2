/** Deliberately non-conformant: the run never ends. */
import type { Counters, Effect, GameModule, Snapshot } from "@clockwork2/kernel"
import { fixtureManifest } from "../manifest"

export class BadGame implements GameModule {
  readonly manifest = fixtureManifest("unbounded", 600)
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
    // Nothing ever makes this true, so the kernel's tick cap is the only
    // bound - which is exactly the shape the platform must refuse.
    return false
  }
  effects(): readonly Effect[] {
    return []
  }
}

export default function createGame(): BadGame {
  return new BadGame()
}
