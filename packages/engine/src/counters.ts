/**
 * Declared counters: the numbers a platform is allowed to rank and reward on.
 *
 * Every one is an integer, because a float that a leaderboard sorts on is a
 * float somebody will eventually tie on by a last bit. `score` is not special;
 * it is one declared counter among others, which is what lets a time trial
 * rank by fewest ticks and a golf game by fewest strokes without pretending
 * either is a score.
 *
 * Objective evaluation is `counters[name] >= threshold`, computed by the
 * platform from the manifest. game-base had four hardcoded operators in a
 * switch and a game-supplied callback for anything else, which the server then
 * ignored in favour of operators hardcoded in SQL, so a new one needed a code
 * change, a migration and a seed.
 */

import type { Counters, PlainValue } from "./contract.js"
import { fail } from "./errors.js"

/** Which way is better. A monotone counter may only move that way. */
export type CounterDirection = "up" | "down"

export type CounterDeclaration = {
  readonly name: string
  readonly direction: CounterDirection
  /** True when the counter may never move against its direction. */
  readonly monotonic: boolean
  readonly label?: string
}

type AssertPlain<T extends PlainValue> = T
export type CounterDeclarationIsPlain = AssertPlain<CounterDeclaration>

/** Ranking: earlier entries decide first. */
export type RankBy = readonly string[]

export const TIE_POLICIES = ["shared", "earliest", "none"] as const
export type TiePolicy = (typeof TIE_POLICIES)[number]

const MAX_SAFE = Number.MAX_SAFE_INTEGER

/**
 * Watches a running session's counters.
 *
 * It is cheap enough to run every tick in the validator and once a second in
 * the browser, and it catches the two things that make a result meaningless: a
 * counter that goes backwards, and a value that is not an integer a ledger can
 * hold.
 */
export class CounterTracker {
  private readonly declarations: ReadonlyMap<string, CounterDeclaration>
  private previous: Counters | null = null
  private wasOver = false

  constructor(declarations: readonly CounterDeclaration[]) {
    const map = new Map<string, CounterDeclaration>()
    for (const declaration of declarations) {
      if (map.has(declaration.name)) {
        fail("E_MANIFEST_INVALID", {
          detail: `counter ${JSON.stringify(declaration.name)} is declared twice`,
        })
      }
      map.set(declaration.name, declaration)
    }
    this.declarations = map
  }

  get names(): readonly string[] {
    return [...this.declarations.keys()]
  }

  /**
   * Checks one reading. Call it with the counters and whether the run has
   * ended; both are what the platform will eventually be paid on.
   */
  check(counters: Counters, isOver: boolean, tick: number): void {
    for (const name of this.declarations.keys()) {
      const value = counters[name]
      if (value === undefined) {
        fail("E_COUNTER_RANGE", {
          tick,
          detail: `declared counter ${JSON.stringify(name)} is missing from score()`,
        })
      }
      if (!Number.isInteger(value) || Math.abs(value) > MAX_SAFE) {
        fail("E_COUNTER_RANGE", {
          tick,
          detail: `counter ${JSON.stringify(name)} is ${String(value)}`,
        })
      }
    }

    for (const key of Object.keys(counters)) {
      if (!this.declarations.has(key)) {
        fail("E_COUNTER_RANGE", {
          tick,
          detail: `score() returned ${JSON.stringify(key)}, which the manifest does not declare`,
        })
      }
    }

    const previous = this.previous
    if (previous !== null) {
      for (const declaration of this.declarations.values()) {
        if (!declaration.monotonic) continue
        const before = previous[declaration.name] as number
        const after = counters[declaration.name] as number
        const moved = after - before
        if (declaration.direction === "up" ? moved < 0 : moved > 0) {
          fail("E_COUNTER_REVERSED", {
            tick,
            detail: `${declaration.name} went from ${before} to ${after}, against its declared direction "${declaration.direction}"`,
          })
        }
      }
    }

    if (this.wasOver && !isOver) {
      fail("E_OVER_FLIPPED", { tick })
    }
    if (isOver) this.wasOver = true

    this.previous = { ...counters }
  }

  reset(): void {
    this.previous = null
    this.wasOver = false
  }
}

/** The only operator there is. An objective is a row in a manifest, not code. */
export function meetsThreshold(
  counters: Counters,
  name: string,
  threshold: number,
): boolean {
  const value = counters[name]
  return value !== undefined && value >= threshold
}

/**
 * Orders two results. Negative means `a` ranks higher.
 *
 * Only replayed counters decide. Clockwork 1's platform ranked by score and
 * then by the server's wall-clock duration, which rewards a fast network.
 */
export function compareByRank(
  a: Counters,
  b: Counters,
  rankBy: RankBy,
  declarations: readonly CounterDeclaration[],
): number {
  const byName = new Map(declarations.map((d) => [d.name, d]))
  for (const name of rankBy) {
    const declaration = byName.get(name)
    if (declaration === undefined) {
      fail("E_MANIFEST_INVALID", {
        detail: `rankBy names ${JSON.stringify(name)}, which is not a declared counter`,
      })
    }
    const left = a[name] ?? 0
    const right = b[name] ?? 0
    if (left === right) continue
    return declaration.direction === "up" ? right - left : left - right
  }
  return 0
}
