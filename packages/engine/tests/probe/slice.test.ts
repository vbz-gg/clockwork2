/**
 * The bisect primitives, and the long vector the sweep only runs with --heavy.
 *
 * When `scripts/engines.ts` finds two engines disagreeing on a vector of a
 * hundred thousand items, it does not ship a hundred thousand values over the
 * wire. It asks each engine for the digest of a range, seventeen times, and
 * narrows to the one item that differs. Everything about that hunt depends on
 * the two functions below agreeing about what a range is, on both engines. An
 * off-by-one here does not fail loudly: it sends someone looking at the wrong
 * item in a divergence they already know is real.
 */

import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { isClockworkError } from "../../src/errors"
import {
  probeDetail,
  probeRange,
  probeVectorIds,
  runProbe,
} from "../../src/probe/index"

const ID = "dmath/sin"

function codeOf(run: () => unknown): string {
  try {
    run()
  } catch (error) {
    return isClockworkError(error) ? error.code : `not ours: ${String(error)}`
  }
  return "(it did not throw)"
}

describe("probeDetail", () => {
  test("returns exactly the half-open range it was asked for", () => {
    const items = probeDetail(ID, 10, 14)
    expect(items.map((i) => i.index)).toEqual([10, 11, 12, 13])
  })

  test("an empty range is empty rather than everything", () => {
    // `from === to` is what a bisect asks for when it has narrowed to nothing.
    expect(probeDetail(ID, 7, 7)).toEqual([])
  })

  test("carries the input beside the output, so a report can show both", () => {
    const [first] = probeDetail(ID, 0, 1)
    expect(first?.in).toMatch(/^[0-9A-F]{16}$/)
    expect(first?.out).toMatch(/^[0-9A-F]{16}$/)
  })

  test("agrees with the head runProbe reports", () => {
    // The head is what a divergence report shows before anyone bisects. If the
    // two disagreed, the first thing a developer saw would be wrong.
    const vector = runProbe({ only: [ID] }).vectors[0]
    expect(probeDetail(ID, 0, 4).map((i) => i.out)).toEqual([
      ...(vector?.head ?? []),
    ])
  })

  test("an unknown id is refused rather than reported as no difference", () => {
    // Returning an empty list would read as "the engines agree here", which is
    // the opposite of what a typo in a vector name means.
    expect(codeOf(() => probeDetail("dmath/nonesuch", 0, 4))).toBe(
      "E_ARG_INVALID",
    )
  })
})

describe("probeRange", () => {
  test("counts the items in the range", () => {
    expect(probeRange(ID, 0, 25).count).toBe(25)
  })

  test("a range past the end counts what there is, not what was asked", () => {
    const whole = runProbe({ only: [ID] }).vectors[0]
    expect(whole).toBeDefined()
    const asked = probeRange(ID, 0, 1_000_000)
    expect(asked.count).toBe(whole?.count ?? -1)
    expect(asked.digest).toBe(whole?.digest ?? "")
  })

  /**
   * The property the whole bisect rests on: adjacent ranges partition the
   * vector. If they overlapped or left a gap, a hunt would narrow onto an item
   * that was never the one that differed.
   */
  test("adjacent ranges cover the vector exactly once", () => {
    const whole = runProbe({ only: [ID] }).vectors[0]
    const total = whole?.count ?? 0
    expect(total).toBeGreaterThan(100)

    const bounds = [0, 1, 17, Math.floor(total / 3), total - 1, total]
    let counted = 0
    for (let i = 0; i < bounds.length - 1; i++) {
      counted += probeRange(
        ID,
        bounds[i] as number,
        bounds[i + 1] as number,
      ).count
    }
    expect(counted).toBe(total)
  })

  test("an empty range has a count of zero and a stable digest", () => {
    const empty = probeRange(ID, 5, 5)
    expect(empty.count).toBe(0)
    expect(empty.digest).toBe(probeRange(ID, 900, 900).digest)
  })

  test("the same range twice gives the same digest", () => {
    // A vector is recomputed from the start on every call, so this is also the
    // check that recomputing is deterministic.
    expect(probeRange(ID, 40, 90).digest).toBe(probeRange(ID, 40, 90).digest)
  })

  test("a different range gives a different digest", () => {
    expect(probeRange(ID, 0, 50).digest).not.toBe(
      probeRange(ID, 50, 100).digest,
    )
  })

  test("an unknown id is refused", () => {
    expect(codeOf(() => probeRange("dmath/nonesuch", 0, 4))).toBe(
      "E_ARG_INVALID",
    )
  })
})

describe("the heavy vector", () => {
  const GOLDEN = join(import.meta.dir, "probe-golden.tsv")
  const HEAVY = "sim/reference-full"

  function goldenDigest(id: string): string | undefined {
    for (const raw of readFileSync(GOLDEN, "utf8").split("\n")) {
      const line = raw.endsWith("\r") ? raw.slice(0, -1) : raw
      if (line.length === 0 || line.startsWith("#")) continue
      const [name, digest] = line.split("\t")
      if (name === id) return digest
    }
    return undefined
  }

  test("is not in the default set", () => {
    expect(probeVectorIds()).not.toContain(HEAVY)
    expect(probeVectorIds({ heavy: true })).toContain(HEAVY)
  })

  /**
   * Three twenty-thousand-tick sessions, checkpointed every second, hashed.
   * `bun run scripts/engines.ts --heavy` makes the same assertion across five
   * engines and is the one that matters; this makes it on one engine, in about
   * a quarter of a second, so a change to the simulation is caught by
   * `bun test` rather than a CI round later. Keep both.
   */
  test("its digest still matches the golden file", () => {
    const vector = runProbe({ only: [HEAVY], heavy: true }).vectors[0]
    expect(vector?.id).toBe(HEAVY)
    expect(vector?.count).toBeGreaterThan(0)
    expect(vector?.digest).toBe(goldenDigest(HEAVY))
  }, 60_000)

  test("runs the three seeds, not one of them three times", () => {
    // One seed repeated would produce a digest that still looked stable while
    // covering a third of the ground.
    const items = probeDetail(HEAVY, 0, 200)
    const seeds = new Set(items.map((i) => i.in.split(/[@:]/)[0]))
    expect([...seeds].sort()).toEqual(["a", "b", "c"])
  }, 60_000)

  test("reports a counters digest for each seed", () => {
    const items = probeDetail(HEAVY, 0, 200)
    const counterItems = items.filter((i) => i.in.endsWith(":counters"))
    expect(counterItems.map((i) => i.in)).toEqual([
      "a:counters",
      "b:counters",
      "c:counters",
    ])
  }, 60_000)
})
