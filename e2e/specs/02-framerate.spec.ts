/**
 * The property Clockwork 1 does not have.
 *
 * One fixed input log, six wildly different frame pacings, and the same state
 * at the end of all of them. Frame jitter may change how *many* ticks a frame
 * runs; it may not change how big a tick is, which is what
 * `deltaTicks = ~~(ticker.deltaTime * 1000)` did.
 *
 * The recording is keyed by tick and never by time, so pacing cannot change
 * which inputs land on which tick. Any difference in the checkpoints means
 * real wall-clock time leaked into the simulation.
 */

import { readFileSync } from "node:fs"
import { expect, test } from "@playwright/test"

const FIXTURE = JSON.parse(
  readFileSync(new URL("../fixtures/snake-01.json", import.meta.url), "utf8"),
) as Record<string, unknown>

const SCHEDULES: Array<[label: string, schedule: unknown]> = [
  ["240 Hz", { kind: "fixed", ms: 1000 / 240 }],
  ["144 Hz", { kind: "fixed", ms: 1000 / 144 }],
  ["60 Hz", { kind: "fixed", ms: 1000 / 60 }],
  ["30 Hz", { kind: "fixed", ms: 1000 / 30 }],
  ["20 Hz", { kind: "fixed", ms: 50 }],
  ["5 Hz", { kind: "fixed", ms: 200 }],
  ["jitter", { kind: "pattern", ms: [7, 33, 11, 64, 4, 19, 250, 8, 16, 1] }],
]

test.describe("frame-rate invariance", () => {
  test("every frame rate reaches the same state", async ({ page }) => {
    await page.goto("/")
    await page.waitForFunction(() => window.__cw2test !== undefined)

    const results = await page.evaluate(
      ({ recording, schedules }) => {
        const api = window.__cw2test
        const out: Record<string, unknown> = {}
        for (const [label, schedule] of schedules) {
          out[label as string] = api?.runFixedLog(
            recording as never,
            schedule as never,
          )
        }
        return out
      },
      { recording: FIXTURE, schedules: SCHEDULES },
    )

    const shapes = new Map<string, string>()
    for (const [label, result] of Object.entries(results)) {
      const typed = result as {
        endTick: number
        counters: unknown
        checkpoints: unknown
      }
      shapes.set(
        label,
        JSON.stringify({
          endTick: typed.endTick,
          counters: typed.counters,
          checkpoints: typed.checkpoints,
        }),
      )
    }
    const distinct = new Set(shapes.values())
    expect(
      distinct.size,
      `frame rates produced ${distinct.size} different games: ${[...shapes.keys()].join(", ")}`,
    ).toBe(1)

    // And it agrees with what the recording says it should be, so the whole
    // set is not identically wrong.
    const first = [...Object.values(results)][0] as { endTick: number }
    expect(first.endTick).toBe(FIXTURE.endTick)
  })

  test("the slow rates really do catch up", async ({ page }) => {
    // Without this the comparison above could pass for the trivial reason
    // that every schedule ran one tick per frame.
    await page.goto("/")
    await page.waitForFunction(() => window.__cw2test !== undefined)
    const [fast, slow] = await page.evaluate((recording) => {
      const api = window.__cw2test
      return [
        api?.runFixedLog(recording as never, { kind: "fixed", ms: 1000 / 240 }),
        api?.runFixedLog(recording as never, { kind: "fixed", ms: 200 }),
      ]
    }, FIXTURE)

    expect(fast?.stats.mostTicksInAFrame).toBe(1)
    expect(slow?.stats.mostTicksInAFrame).toBeGreaterThan(1)
    expect(slow?.stats.frames).toBeLessThan((fast?.stats.frames ?? 0) / 3)
    expect(slow?.stats.ticksRun).toBe(fast?.stats.ticksRun)
  })

  test("a throttled processor changes nothing @cdp", async ({
    page,
    browserName,
  }) => {
    test.skip(
      browserName !== "chromium",
      "CPU throttling is a Chromium protocol",
    )
    await page.goto("/")
    await page.waitForFunction(() => window.__cw2test !== undefined)

    const cdp = await page.context().newCDPSession(page)
    const results: unknown[] = []
    for (const rate of [1, 4, 20]) {
      await cdp.send("Emulation.setCPUThrottlingRate", { rate })
      results.push(
        await page.evaluate(
          (recording) =>
            window.__cw2test?.runFixedLog(recording as never, {
              kind: "fixed",
              ms: 1000 / 60,
            }),
          FIXTURE,
        ),
      )
    }
    await cdp.send("Emulation.setCPUThrottlingRate", { rate: 1 })

    const shapes = new Set(results.map((result) => JSON.stringify(result)))
    expect(shapes.size, "a slower processor changed the game").toBe(1)
  })
})
