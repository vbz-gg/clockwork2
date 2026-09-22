/**
 * Deliberately non-conformant: a counter is not a whole number.
 *
 * The realistic version of this bug is a game that accumulates a score in
 * floating point and hands the total straight to `score()`. Counters are
 * integers because a platform compares and ranks them, and two runs that agree
 * to fifteen digits and differ in the sixteenth must not tie on one engine and
 * separate on another.
 */

import type { Counters, Effect, GameModule, Snapshot } from "@clockwork2/engine"
import { fixtureManifest } from "../manifest"

export class CounterFractionalGame implements GameModule {
  readonly manifest = fixtureManifest("counter-fractional", 600)
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
    return { score: this.ticks / 4, ticksSurvived: this.ticks }
  }
  isOver(): boolean {
    return this.ticks >= 300
  }
  effects(): readonly Effect[] {
    return []
  }
}

export default function createGame(): CounterFractionalGame {
  return new CounterFractionalGame()
}
