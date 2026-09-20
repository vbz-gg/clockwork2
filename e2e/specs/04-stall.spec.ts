/**
 * What happens when the page stops getting frames.
 *
 * Two things have to hold. The loop drops the debt rather than banking it, so
 * a tab that was in the background for four minutes does not come back and run
 * fourteen thousand input-free ticks in one frame. And the session that
 * stalled still replays exactly, because dropping time is only correct if the
 * drop is *recorded*: a host that dropped ticks while reporting a tick count
 * as though it had not would produce a log that replays somewhere else.
 */

import { readFileSync } from "node:fs"
import { expect, test } from "@playwright/test"
import { payload } from "./support"

const FIXTURE = JSON.parse(
  readFileSync(new URL("../fixtures/snake-03.json", import.meta.url), "utf8"),
) as Record<string, unknown>

test.describe("a stalled loop", () => {
  test("drops its debt and reaches the same state anyway", async ({ page }) => {
    await page.goto("/")
    await page.waitForFunction(() => window.__cw2test !== undefined)

    const [steady, stalled] = await page.evaluate((recording) => {
      const api = window.__cw2test
      return [
        api?.runFixedLog(recording as never, { kind: "fixed", ms: 1000 / 60 }),
        api?.runFixedLog(recording as never, {
          kind: "stall",
          ms: 1000 / 60,
          atFrame: 120,
          // Four minutes in the background.
          stallMs: 240_000,
        }),
      ]
    }, FIXTURE)

    expect(stalled?.stats.droppedMs ?? 0).toBeGreaterThan(200_000)
    expect(stalled?.stats.mostTicksInAFrame ?? 0).toBeLessThanOrEqual(5)
    // A fixed log under different pacing is still the same game.
    expect(stalled?.checkpoints).toEqual(steady?.checkpoints)
    expect(stalled?.counters).toEqual(steady?.counters)
    expect(stalled?.endTick).toBe(steady?.endTick)
  })

  test("a live session blocked on the main thread still replays", async ({
    page,
  }) => {
    await page.goto("/")
    await page.waitForFunction(() => window.__cw2test !== undefined)
    await page.evaluate(() => {
      window.__cw2test?.reset("e2e-stall")
    })
    await page.waitForTimeout(600)

    // A real block, on the real clock, the way a long task behaves.
    await page.evaluate(() => {
      const until = performance.now() + 2500
      while (performance.now() < until) {
        // deliberately busy
      }
    })
    await page.waitForTimeout(400)

    const stats = await page.evaluate(() => window.__cw2test?.loopStats())
    expect(stats?.mostTicksInAFrame ?? 0).toBeLessThanOrEqual(5)

    await page.evaluate(() => {
      window.__cw2test?.stop()
    })
    const { recording, checkpoints } = await page.evaluate(() => ({
      recording: window.__cw2test?.recording(),
      checkpoints: window.__cw2test?.checkpoints(),
    }))
    const replayed = await page.evaluate(
      (input) =>
        window.__cw2test?.runFixedLog(input as never, {
          kind: "fixed",
          ms: 1000 / 60,
        }),
      payload(recording),
    )
    expect(replayed?.checkpoints).toEqual(checkpoints)
    expect(replayed?.endTick).toBe(recording?.endTick)
  })
})
