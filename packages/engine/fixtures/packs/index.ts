/**
 * A conforming game with data packs, used as the suite's positive control for
 * them, and by the host tests as the game every host must agree about.
 *
 * `data/rules.json` is a start pack: `init` reads it. `data/level-2.json` is
 * a demand pack: `packsNeeded()` names it from tick 300, the game reads it
 * from then on, and records in `openedAt` the tick it first did. Every host,
 * however late the pack arrives, has to report 300. At tick 240 the game
 * hints at the pack with a prefetch effect, unless its config turns that off,
 * which is how a test makes a host wait.
 *
 * The parsed level is kept out of the snapshot and reopened on the first tick
 * after a restore, which is the pattern the docs recommend: a snapshot holds
 * pack names and positions, never pack contents.
 */

import {
  type Counters,
  type Effect,
  type GameModule,
  type InputEvent,
  type Manifest,
  type PackReader,
  Prng,
  type PrngState,
  type Snapshot,
} from "@clockwork2/engine"
import { fixtureManifest } from "../manifest"

const base = fixtureManifest("packs-fixture", 3600)

export const RULES = "data/rules.json"
export const LEVEL = "data/level-2.json"
/** The tick from which the level is needed. */
export const LEVEL_FROM = 300
/** The tick at which the game hints that it will need the level. */
export const PREFETCH_AT = 240

export const MANIFEST: Manifest = {
  ...base,
  assets: [
    {
      path: RULES,
      sha256:
        "09d9a4db066d6e702afcc44a4c6a9f5ec59d76a43498335545ba8a339cf73fdd",
      bytes: 26,
      requiredForSim: true,
      license: "CC0-1.0",
    },
    {
      path: LEVEL,
      sha256:
        "26113b280d89015f0ef93ebcb5c7f4bb6eff0fb5008fdc3997e7d82bcafa538c",
      bytes: 28,
      requiredForSim: true,
      load: "demand",
      license: "CC0-1.0",
    },
  ],
}

export type PacksView = {
  readonly value: number
  readonly ticks: number
  readonly openedAt: number
}

type Rules = { readonly step: number; readonly beat: number }
type Level = { readonly bonus: number; readonly every: number }

export class PacksGame implements GameModule<PacksView> {
  readonly manifest = MANIFEST
  private packs!: PackReader
  private rng!: Prng
  private rules: Rules = { step: 0, beat: 1 }
  private level: Level | null = null
  private prefetch = true
  private value = 0
  private ticks = 0
  private openedAt = -1
  private pending: Effect[] = []

  init(seed: string, config: unknown, packs: PackReader): void {
    this.packs = packs
    this.rng = new Prng(seed)
    this.rules = packs.json(RULES) as Rules
    this.prefetch =
      (config as { prefetch?: unknown } | null)?.prefetch !== false
    this.level = null
    this.value = 0
    this.ticks = 0
    this.openedAt = -1
    this.pending = []
  }

  tick(inputs: readonly InputEvent[]): void {
    for (const input of inputs) {
      if (input.code === "push" && input.value > 0)
        this.value += this.rules.step
    }
    if (this.ticks % this.rules.beat === 0) {
      this.value += this.rng.randomInt(1, 3)
    }
    if (this.ticks >= LEVEL_FROM) {
      this.level ??= this.packs.json(LEVEL) as Level
      if (this.openedAt < 0) this.openedAt = this.ticks
      if (this.ticks % this.level.every === 0) this.value += this.level.bonus
    }
    this.ticks++
    if (this.prefetch && this.ticks === PREFETCH_AT) {
      this.pending.push({ type: "prefetch", data: LEVEL })
    }
  }

  packsNeeded(): readonly string[] {
    return this.ticks >= LEVEL_FROM ? [LEVEL] : []
  }

  view(): PacksView {
    return { value: this.value, ticks: this.ticks, openedAt: this.openedAt }
  }

  snapshot(): Snapshot {
    return {
      value: this.value,
      ticks: this.ticks,
      openedAt: this.openedAt,
      prefetch: this.prefetch,
      rng: this.rng.exportState() as unknown as Snapshot,
    }
  }

  restore(snapshot: Snapshot): void {
    const s = snapshot as unknown as {
      value: number
      ticks: number
      openedAt: number
      prefetch: boolean
      rng: PrngState
    }
    this.value = s.value
    this.ticks = s.ticks
    this.openedAt = s.openedAt
    this.prefetch = s.prefetch
    this.rng.importState(s.rng)
    // Reopened on the next tick that needs it, which packsNeeded() will name.
    this.level = null
    this.pending = []
  }

  score(): Counters {
    return { score: this.value, ticksSurvived: this.ticks }
  }

  isOver(): boolean {
    return this.ticks >= 1800
  }

  effects(): readonly Effect[] {
    const drained = this.pending
    this.pending = []
    return drained
  }
}

export default function createGame(): PacksGame {
  return new PacksGame()
}
