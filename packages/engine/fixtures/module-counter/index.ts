/**
 * A game whose entity ids come from a module-level counter.
 *
 * This is the shape that makes "a fresh instance" the wrong unit: constructing
 * a second game does not reset the counter, so the second session starts with
 * different ids and diverges from the first. Only evaluating the module again
 * puts it back. tiki-kong had exactly this.
 */
import type { Counters, Effect, GameModule, Snapshot } from "@clockwork2/engine"
import { fixtureManifest } from "../manifest"

let nextId = 1

export class CounterGame implements GameModule {
  readonly manifest = fixtureManifest("module-counter")
  private ticks = 0
  private firstId = 0

  init(): void {
    this.ticks = 0
    this.firstId = nextId++
  }
  tick(): void {
    this.ticks++
  }
  view(): unknown {
    return { firstId: this.firstId }
  }
  snapshot(): Snapshot {
    return { ticks: this.ticks, firstId: this.firstId }
  }
  restore(snapshot: Snapshot): void {
    this.ticks = snapshot.ticks as number
    this.firstId = snapshot.firstId as number
  }
  score(): Counters {
    return { score: this.firstId, ticksSurvived: this.ticks }
  }
  isOver(): boolean {
    return this.ticks >= 120
  }
  effects(): readonly Effect[] {
    return []
  }
}

export default function createGame(): CounterGame {
  return new CounterGame()
}
