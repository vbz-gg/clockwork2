/**
 * The simulation's randomness.
 *
 * Three things here that Clockwork 1's `PRNG` did not have, each fixing a real
 * failure:
 *
 * A seed is required. Clockwork 1 called `alea()` with no argument in its
 * constructor, which seeds from the wall clock, and relied on a later
 * `reset(seed)`. A config with no `prngSeed` reseeded with `alea("")`.
 *
 * Generator state is part of the snapshot. `exportState` and `importState`
 * exist on alea and Clockwork 1's wrapper hid them, so restoring game state
 * alone diverged on the very next draw and there was no way to notice.
 *
 * Sub-streams are labelled and owned. A visual flourish drawing from the same
 * stream as the gameplay changes the game, and a sub-stream seeded from a
 * parent's *position* would do the same thing more subtly. A child here is
 * seeded from the parent's seed and its label, so drawing from one never moves
 * the other. The parent owns its children, so one `exportState` covers the
 * whole tree and a game cannot forget to snapshot one.
 */

import type { PlainValue } from "../contract"
import { fail } from "../errors"
import { type Alea, type AleaState, createAlea } from "./alea"

export type { Alea, AleaState } from "./alea"
export { createAlea } from "./alea"

/** Plain data, so it drops straight into a snapshot. */
export type PrngState = {
  readonly s: AleaState
  /**
   * The seed, on the root only.
   *
   * It is here because a sub-stream created *after* a snapshot was taken is
   * seeded from its parent's seed, so restoring the generator positions is not
   * enough: a restored game that later reaches for a stream it had not used
   * yet would seed it from whatever the restoring module was constructed with
   * and draw a different sequence from then on. That failure is invisible in
   * the snapshot itself, which compares equal, and shows up minutes later as a
   * replay that does not match.
   */
  readonly seed?: string
  /** Sub-streams by label, only those that have been created. */
  readonly k?: { readonly [label: string]: PrngState }
}

/** Separates a seed from a label so `a` + `bc` cannot collide with `ab` + `c`. */
const LABEL_SEPARATOR = "\u0000"

export class Prng {
  private readonly alea: Alea
  private readonly children = new Map<string, Prng>()
  private seedValue: string

  constructor(seed: string) {
    if (typeof seed !== "string" || seed.length === 0) {
      fail("E_SEED_REQUIRED", { detail: "a seed must be a non-empty string" })
    }
    this.seedValue = seed
    this.alea = createAlea(seed)
  }

  /** What this stream was seeded from. Sub-streams derive their own from it. */
  get seed(): string {
    return this.seedValue
  }

  /** A double in [0, 1). */
  random(): number {
    return this.alea()
  }

  /** A uniform 32-bit unsigned integer. */
  randomUint32(): number {
    return this.alea.uint32()
  }

  /** An integer in [min, max], both ends included. */
  randomInt(min: number, max: number): number {
    return Math.floor(this.alea() * (max - min + 1)) + min
  }

  /** A double in [min, max). */
  randomFloat(min: number, max: number): number {
    return this.alea() * (max - min) + min
  }

  /** True with probability `threshold`. */
  randomBoolean(threshold = 0.5): boolean {
    return this.alea() < threshold
  }

  /** One item, uniformly. Throws on an empty list rather than returning undefined. */
  randomChoice<T>(items: readonly T[]): T {
    if (items.length === 0) {
      fail("E_ARG_INVALID", { detail: "randomChoice() on an empty array" })
    }
    return items[Math.floor(this.alea() * items.length)] as T
  }

  /** Fisher-Yates, in place, drawing exactly `items.length - 1` times. */
  shuffle<T>(items: T[]): T[] {
    for (let i = items.length - 1; i > 0; i--) {
      const j = Math.floor(this.alea() * (i + 1))
      const a = items[i] as T
      items[i] = items[j] as T
      items[j] = a
    }
    return items
  }

  /**
   * A labelled sub-stream, created on first use and memoised. Drawing from it
   * never moves this stream, and drawing from this stream never moves it.
   */
  stream(label: string): Prng {
    const existing = this.children.get(label)
    if (existing !== undefined) return existing
    const child = new Prng(`${this.seedValue}${LABEL_SEPARATOR}${label}`)
    this.children.set(label, child)
    return child
  }

  /** The whole tree, as plain data. Put this in your snapshot. */
  exportState(): PrngState {
    const base = { s: this.alea.exportState(), seed: this.seedValue }
    if (this.children.size === 0) return base
    const k: Record<string, PrngState> = {}
    // Sorted so the encoding does not depend on which sub-stream was used first.
    for (const label of [...this.children.keys()].sort()) {
      k[label] = (this.children.get(label) as Prng).exportState()
    }
    return { ...base, k }
  }

  /**
   * Restores the whole tree. A sub-stream named in the state is created if this
   * instance has not reached it yet, which is what makes restoring into a fresh
   * module work.
   */
  importState(state: PrngState): void {
    this.alea.importState(state.s)
    // The seed comes back too, so a sub-stream reached for later is derived
    // from the same parent it would have been derived from originally.
    if (state.seed !== undefined) this.seedValue = state.seed
    const k = state.k
    if (k === undefined) return
    for (const label of Object.keys(k)) {
      this.stream(label).importState(k[label] as PrngState)
    }
  }

  /** Back to the start of the stream, sub-streams included. */
  reset(): void {
    const fresh = createAlea(this.seedValue)
    this.alea.importState(fresh.exportState())
    for (const child of this.children.values()) child.reset()
  }
}

/**
 * Compile-time proof that a PrngState can go straight into a snapshot. If a
 * field is ever added that the canonical encoder would refuse, this stops
 * building rather than failing at the first hash.
 */
type AssertPlain<T extends PlainValue> = T
export type PrngStateIsPlain = AssertPlain<PrngState>
