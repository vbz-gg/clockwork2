/**
 * Deliberately non-conformant: the bundle reaches for the embedder.
 *
 * A game that can read `window.parent` can read the page that is hosting it,
 * and a game that can read `document.cookie` can read the session of whoever
 * is playing. Neither is something a simulation needs, so both are refused by
 * name rather than by sandbox alone.
 *
 * The reads sit in a method nothing calls. That is on purpose: the point is
 * that the static scan finds them wherever they are, and the alternative,
 * running them, would only prove that `window` is undefined under bun.
 */

import type { Counters, Effect, GameModule, Snapshot } from "@clockwork2/engine"
import { fixtureManifest } from "../manifest"

export class GlobalsTouchedGame implements GameModule {
  readonly manifest = fixtureManifest("globals-touched", 600)
  private ticks = 0

  /** The shape this arrives in: a "resume where you left off" convenience. */
  private restoreFromHost(): string {
    const embedder = window.parent.location.href
    const saved = document.cookie
    return `${embedder}:${saved}`
  }

  init(): void {
    this.ticks = 0
  }
  tick(): void {
    this.ticks++
  }
  view(): unknown {
    return { ticks: this.ticks, host: this.restoreFromHost.name }
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
    return this.ticks >= 300
  }
  effects(): readonly Effect[] {
    return []
  }
}

export default function createGame(): GlobalsTouchedGame {
  return new GlobalsTouchedGame()
}
