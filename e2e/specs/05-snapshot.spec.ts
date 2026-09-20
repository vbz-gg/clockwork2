/**
 * Restore, then continue, and end up where you would have anyway.
 *
 * The second test is the one that earns its keep. Restoring into a *fresh
 * realm* is the only way to catch state that lives outside the snapshot - a
 * module-level id counter, a memoised cache, a queue held in a closure. In the
 * same page those survive the restore and hide the bug; in a new context they
 * do not.
 */

import { readFileSync } from "node:fs"
import { expect, test } from "@playwright/test"

const FIXTURE = JSON.parse(
  readFileSync(new URL("../fixtures/snake-01.json", import.meta.url), "utf8"),
) as Record<string, unknown> & { endTick: number }

/**
 * Runs the fixture forward to `tick` in a throwaway host and takes its state.
 *
 * Deliberately not the visible session's snapshot: that is a different game,
 * on a different seed, at a different tick.
 */
async function snapshotAt(
  page: import("@playwright/test").Page,
  tick: number,
): Promise<unknown> {
  return page.evaluate(
    ({ recording, at }) => {
      const truncated = {
        ...(recording as Record<string, unknown>),
        endTick: at,
        inputs: (
          recording as unknown as { inputs: Array<{ tick: number }> }
        ).inputs.filter((input) => input.tick < at),
        checkpoints: [],
      }
      return window.__cw2test?.runFixedLog(truncated as never, {
        kind: "fixed",
        ms: 1000 / 60,
      }).snapshot
    },
    { recording: FIXTURE, at: tick },
  )
}

test.describe("restore then continue", () => {
  test("the live page's snapshot round trips through JSON", async ({
    page,
  }) => {
    await page.goto("/")
    await page.waitForFunction(() => window.__cw2test !== undefined)
    const snapshot = await page.evaluate(() => window.__cw2test?.snapshot())
    expect(snapshot).toBeDefined()
    // It came back through the wire as JSON, which is the trip it takes for
    // real, so anything unserialisable in it would already have failed.
    expect(JSON.parse(JSON.stringify(snapshot))).toEqual(snapshot as never)
  })

  test("resuming mid-recording reaches the same end", async ({ page }) => {
    await page.goto("/")
    await page.waitForFunction(() => window.__cw2test !== undefined)

    const whole = await page.evaluate(
      (recording) =>
        window.__cw2test?.runFixedLog(recording as never, {
          kind: "fixed",
          ms: 1000 / 60,
        }),
      FIXTURE,
    )

    for (const at of [60, 300, Math.floor(FIXTURE.endTick / 2)]) {
      const partial = await snapshotAt(page, at)

      const resumed = await page.evaluate(
        ({ snapshot, tick, recording }) =>
          window.__cw2test?.restoreAndContinue(
            snapshot as never,
            tick,
            recording as never,
          ),
        { snapshot: partial, tick: at, recording: FIXTURE },
      )

      expect(resumed?.endTick, `resuming at ${at}`).toBe(whole?.endTick)
      expect(resumed?.counters, `resuming at ${at}`).toEqual(whole?.counters)
      const later = (whole?.checkpoints ?? []).filter((c) => c.tick >= at)
      for (const checkpoint of later) {
        const other = resumed?.checkpoints.find(
          (c) => c.tick === checkpoint.tick,
        )
        expect(other?.hash, `resuming at ${at}, tick ${checkpoint.tick}`).toBe(
          checkpoint.hash,
        )
      }
    }
  })

  test("a snapshot restores into a realm that has never seen the game", async ({
    browser,
  }) => {
    // A module-level counter survives a fresh instance and a fresh page reload
    // in the same context. A new context is the honest test.
    const first = await browser.newContext()
    const producer = await first.newPage()
    await producer.goto("/")
    await producer.waitForFunction(() => window.__cw2test !== undefined)
    const at = 420
    const snapshot = await snapshotAt(producer, at)
    const whole = await producer.evaluate(
      (recording) =>
        window.__cw2test?.runFixedLog(recording as never, {
          kind: "fixed",
          ms: 1000 / 60,
        }),
      FIXTURE,
    )
    await first.close()

    const second = await browser.newContext()
    const consumer = await second.newPage()
    await consumer.goto("/")
    await consumer.waitForFunction(() => window.__cw2test !== undefined)
    const resumed = await consumer.evaluate(
      ({ snapshot: state, tick, recording }) =>
        window.__cw2test?.restoreAndContinue(
          state as never,
          tick,
          recording as never,
        ),
      { snapshot, tick: at, recording: FIXTURE },
    )
    await second.close()

    expect(resumed?.endTick).toBe(whole?.endTick)
    expect(resumed?.counters).toEqual(whole?.counters)
    for (const checkpoint of (whole?.checkpoints ?? []).filter(
      (c) => c.tick >= at,
    )) {
      const other = resumed?.checkpoints.find((c) => c.tick === checkpoint.tick)
      expect(other?.hash, `tick ${checkpoint.tick}`).toBe(checkpoint.hash)
    }
  })
})
