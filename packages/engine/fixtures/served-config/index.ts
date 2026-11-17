/**
 * A conforming game whose ending comes from a parameter's default: it ends at
 * `config.endAt`, and fills in no default of its own. Under the served config,
 * every declared parameter at its default, it ends at tick 900. Under an empty
 * config it would read `undefined`, never end, and run every log to the check
 * window, so the end tick says which config the checks played.
 */
import {
  type Counters,
  type Effect,
  type GameModule,
  type InputEvent,
  type Manifest,
  Prng,
  type PrngState,
  type Snapshot,
} from "@clockwork2/engine"
import { fixtureManifest } from "../manifest"

export const MANIFEST: Manifest = {
  ...fixtureManifest("served-config"),
  params: {
    endAt: { type: "int", label: "Ends at", min: 60, default: 900 },
    title: { type: "string", label: "Title", optional: true },
  },
}

type Config = { readonly endAt: number }

export class ServedConfigGame implements GameModule<unknown, Config> {
  readonly manifest = MANIFEST
  private config: Config = { endAt: 0 }
  private rng!: Prng
  private value = 0
  private ticks = 0
  init(seed: string, config: Config): void {
    this.config = config
    this.rng = new Prng(seed)
    this.value = 0
    this.ticks = 0
  }
  tick(inputs: readonly InputEvent[]): void {
    for (const input of inputs) {
      if (input.code === "push" && input.value > 0) this.value += 1
    }
    if (this.ticks % 30 === 0) {
      this.value += this.rng.randomInt(1, 3)
    }
    this.ticks++
  }
  view(): unknown {
    return { value: this.value }
  }
  snapshot(): Snapshot {
    return {
      config: this.config,
      value: this.value,
      ticks: this.ticks,
      rng: this.rng.exportState() as unknown as Snapshot,
    }
  }
  restore(snapshot: Snapshot): void {
    const s = snapshot as unknown as {
      config: Config
      value: number
      ticks: number
      rng: PrngState
    }
    this.config = s.config
    this.value = s.value
    this.ticks = s.ticks
    this.rng.importState(s.rng)
  }
  score(): Counters {
    return { score: this.value, ticksSurvived: this.ticks }
  }
  isOver(): boolean {
    return this.ticks >= this.config.endAt
  }
  effects(): readonly Effect[] {
    return []
  }
}

export default function createGame(): ServedConfigGame {
  return new ServedConfigGame()
}
