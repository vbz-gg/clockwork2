/**
 * Many seeds, two input densities each, three frame schedules each.
 *
 * The other specs each pin one property on one or two hand-played sessions.
 * This one asks whether those properties hold across the space: twenty seeds,
 * two pseudo-random input logs per seed, and every log replayed under a steady
 * 60 Hz, a jittery display and a schedule with a four-second stall in it. All
 * six runs of a seed must agree exactly.
 *
 * It is tagged `@nightly` and excluded from the ordinary run. The value of
 * running it at all is that a determinism bug in a rarely-visited branch - a
 * wall spawning onto the head, an apple expiring the tick it is eaten, the
 * snake wrapping into its own tail - shows up as one seed failing while
 * nineteen pass, which localises it far better than a single session going red.
 *
 * The logs come from an integer LCG rather than `Math.random`, so a failing
 * seed is reproducible: the seed list and the generator below are the whole
 * input. A random player dies in a few hundred ticks and rarely reaches an
 * apple, so this spec is about breadth of seeds, not depth of play; the frozen
 * fixtures cover the long, high-scoring sessions.
 */

import { readFileSync } from "node:fs"
import { expect, test } from "@playwright/test"
import { payload } from "./support"

const TEMPLATE = JSON.parse(
  readFileSync(new URL("../fixtures/snake-01.json", import.meta.url), "utf8"),
) as Record<string, unknown>

const SEEDS = Array.from(
  { length: 20 },
  (_, i) => `fuzz-${String(i).padStart(2, "0")}`,
)

/** Ample: a random player dies long before this. */
const MAX_TICKS = 3600

/**
 * The shortest run the measured seeds produce is about 120 ticks. Guarding
 * well under that keeps the check honest without making it a flake: a run of
 * four ticks would satisfy every comparison in the test while proving nothing.
 */
const MIN_END_TICK = 100

interface Run {
  readonly label: string
  readonly endTick: number
  readonly terminal: string
  readonly counters: Record<string, number>
  readonly checkpoints: ReadonlyArray<{ tick: number; hash: string }>
}

interface SeedResult {
  readonly seed: string
  readonly density: string
  readonly inputCount: number
  readonly runs: readonly Run[]
}

test.describe("fuzz", { tag: "@nightly" }, () => {
  test("seeded sessions agree across frame schedules", async ({ page }) => {
    await page.goto("/")
    await page.waitForFunction(() => window.__cw2test !== undefined)

    const results = await page.evaluate(
      ({ template, seeds, maxTicks }) => {
        const api = window.__cw2test
        if (api === undefined) throw new Error("no test api")

        // A 32-bit LCG. Integer arithmetic only, so it produces the same log
        // in every browser and a failing seed is reproducible from this file.
        function lcg(seed: string): () => number {
          let s = 0
          for (let i = 0; i < seed.length; i++) {
            s = (Math.imul(s, 31) + seed.charCodeAt(i)) >>> 0
          }
          return () => {
            s = (Math.imul(s, 1103515245) + 12345) >>> 0
            return s >>> 8
          }
        }

        const CODES = ["up", "down", "left", "right"]
        // Dense turns land both between moves and on one; sparse ones let the
        // snake run long enough to meet a wall it did not steer into.
        const DENSITIES = [
          ["dense", 3, 32],
          ["sparse", 60, 240],
        ] as const
        const SCHEDULES = [
          ["steady", { kind: "fixed", ms: 1000 / 60 }],
          ["jitter", { kind: "pattern", ms: [4, 33, 8, 51, 16, 12, 70, 6] }],
          [
            "stall",
            { kind: "stall", ms: 1000 / 60, atFrame: 90, stallMs: 4000 },
          ],
        ] as const

        const out = []
        for (const seed of seeds as string[]) {
          for (const [density, low, span] of DENSITIES) {
            const next = lcg(`${seed}/${density}`)
            const inputs = []
            for (let tick = 0; tick < (maxTicks as number); ) {
              tick += low + (next() % span)
              inputs.push({
                tick,
                device: "key",
                code: CODES[next() % 4] as string,
                value: 1,
              })
            }

            const recording = {
              ...(template as Record<string, unknown>),
              seed,
              inputs,
              endTick: maxTicks,
              checkpoints: [],
            }

            const runs = []
            for (const [label, schedule] of SCHEDULES) {
              const result = api.runFixedLog(
                recording as never,
                schedule as never,
              )
              runs.push({
                label,
                endTick: result.endTick,
                terminal: result.terminal,
                counters: result.counters as Record<string, number>,
                checkpoints: result.checkpoints as Array<{
                  tick: number
                  hash: string
                }>,
              })
            }
            out.push({ seed, density, inputCount: inputs.length, runs })
          }
        }
        return out
      },
      { template: payload(TEMPLATE), seeds: SEEDS, maxTicks: MAX_TICKS },
    )

    const fleet = results as unknown as SeedResult[]
    expect(fleet.length).toBe(SEEDS.length * 2)

    for (const { seed, density, inputCount, runs } of fleet) {
      const where = `${seed}/${density}`
      const [steady, ...rest] = runs
      if (steady === undefined) throw new Error(`${where}: no runs`)

      expect(inputCount, `${where}: inputs generated`).toBeGreaterThan(10)
      expect(steady.endTick, `${where}: ticks simulated`).toBeGreaterThan(
        MIN_END_TICK,
      )
      expect(
        steady.checkpoints.length,
        `${where}: checkpoints`,
      ).toBeGreaterThan(1)

      for (const run of rest) {
        expect(run.endTick, `${where}: ${run.label} end tick`).toBe(
          steady.endTick,
        )
        expect(run.terminal, `${where}: ${run.label} terminal`).toBe(
          steady.terminal,
        )
        expect(run.counters, `${where}: ${run.label} counters`).toEqual(
          steady.counters,
        )
        expect(run.checkpoints, `${where}: ${run.label} checkpoints`).toEqual(
          steady.checkpoints,
        )
      }
    }

    // The seeds have to actually differ, or forty identical sessions would
    // satisfy everything above while testing one trajectory.
    const distinct = new Set(
      fleet.map((r) =>
        (r.runs[0]?.checkpoints ?? []).map((c) => c.hash).join(","),
      ),
    )
    expect(
      distinct.size,
      "seeds produced distinct trajectories",
    ).toBeGreaterThan(fleet.length - 4)
  })
})
