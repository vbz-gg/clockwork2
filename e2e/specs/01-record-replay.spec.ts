/**
 * Record a real session, replay the log, compare.
 *
 * The keys are pressed at wall-clock-uncontrolled moments, the way a person
 * presses them, so the *recording* differs from run to run. That is correct
 * and it is the point. The invariant under test is not "these keystrokes give
 * this game" but:
 *
 *   for any recording the host emits, replaying it reproduces the exact state
 *   trajectory the host visited, and that replay is a pure function of the
 *   recording.
 *
 * A test that pinned the input timing would be testing a lab fiction, and it
 * would miss the likeliest bug in the whole system: the host stamping an input
 * against the wrong tick. That bug makes every submitted score unverifiable,
 * and only a real-event test finds it.
 */

import { expect, test } from "@playwright/test"
import { payload, playGreedily } from "./support"

test.describe("record and replay", () => {
  test("a played session replays to the state it reached", async ({ page }) => {
    await page.goto("/")
    await page.waitForFunction(() => window.__cw2test !== undefined)
    await page.evaluate(() => {
      window.__cw2test?.reset("e2e-record")
    })

    await playGreedily(page, 8)
    await page.evaluate(() => {
      window.__cw2test?.stop()
    })

    const { recording, checkpoints } = await page.evaluate(() => ({
      recording: window.__cw2test?.recording(),
      checkpoints: window.__cw2test?.checkpoints(),
    }))
    expect(recording).toBeDefined()

    // Without these, a page that silently recorded nothing passes everything
    // below it.
    const played = recording as NonNullable<typeof recording>
    expect(played.inputs.length, "inputs recorded").toBeGreaterThan(10)
    expect(played.endTick, "ticks simulated").toBeGreaterThan(200)
    expect((checkpoints ?? []).length, "checkpoints taken").toBeGreaterThan(3)

    const replayed = await page.evaluate(
      (input) =>
        window.__cw2test?.runFixedLog(input as never, {
          kind: "fixed",
          ms: 1000 / 60,
        }),
      payload(played),
    )

    expect(replayed?.endTick).toBe(played.endTick)
    expect(replayed?.counters).toEqual(played.counters)
    expect(replayed?.checkpoints).toEqual(checkpoints)
  })

  test("a session with no input at all still ends and still replays", async ({
    page,
  }) => {
    await page.goto("/")
    await page.waitForFunction(() => window.__cw2test !== undefined)
    await page.evaluate(() => {
      window.__cw2test?.reset("e2e-idle")
    })
    // Walls keep arriving, so a snake nobody steers dies. That is what makes
    // the run bounded without the tick cap having to do it.
    await page.waitForFunction(
      () => window.__cw2test?.state().running === false,
      undefined,
      { timeout: 60_000 },
    )

    const { recording, checkpoints } = await page.evaluate(() => ({
      recording: window.__cw2test?.recording(),
      checkpoints: window.__cw2test?.checkpoints(),
    }))
    const played = recording as NonNullable<typeof recording>
    expect(played.inputs.length).toBe(0)
    expect(played.endTick).toBeGreaterThan(60)

    const replayed = await page.evaluate(
      (input) =>
        window.__cw2test?.runFixedLog(input as never, {
          kind: "fixed",
          ms: 1000 / 60,
        }),
      payload(played),
    )
    expect(replayed?.checkpoints).toEqual(checkpoints)
  })

  test("two replays of one recording agree", async ({ page }) => {
    await page.goto("/")
    await page.waitForFunction(() => window.__cw2test !== undefined)
    const fixture = await import("node:fs").then((fs) =>
      JSON.parse(
        fs.readFileSync(
          new URL("../fixtures/snake-01.json", import.meta.url),
          "utf8",
        ),
      ),
    )
    const [first, second] = await page.evaluate((input) => {
      const api = window.__cw2test
      return [
        api?.runFixedLog(input, { kind: "fixed", ms: 1000 / 60 }),
        api?.runFixedLog(input, { kind: "fixed", ms: 1000 / 60 }),
      ]
    }, fixture)
    expect(first).toEqual(second)
  })
})
