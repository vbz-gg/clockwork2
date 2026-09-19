/**
 * The demo's own controls, driven the way a person drives them.
 *
 * Every other spec reaches into `window.__cw2test`, which is the right way to
 * test the engine and the wrong way to find out whether the page works. This
 * one clicks the buttons and drags the slider, and reads the answer off the
 * panel rather than out of the API: the demo prints the hash it recorded and
 * the hash the replay reached, and says "identical" when they match. That
 * line is the demo's whole claim, and nothing else checks that it is wired to
 * anything.
 *
 * It also covers replay speed, which is a control with no other test. Speed is
 * ticks per frame in the loop, not a renderer property, so changing it must
 * change how fast the replay advances and must not change where it ends up.
 */

import type { Page } from "@playwright/test"
import { expect, test } from "@playwright/test"
import { MIN_TICKS, playGreedily } from "./support"

/** Ticks simulated over `ms` of wall clock, as the page reports them. */
async function ticksPer(page: Page, ms: number): Promise<number> {
  const before = await page.evaluate(() => window.__cw2test?.state().tick ?? 0)
  await page.waitForTimeout(ms)
  const after = await page.evaluate(() => window.__cw2test?.state().tick ?? 0)
  return after - before
}

/**
 * Records a session worth replaying, through the buttons.
 *
 * Same reasoning as `playSubstantialSession`: how long a greedy player
 * survives is a property of the board, so the spec plays again on another
 * seed rather than asserting a length the snake sometimes misses. Here it
 * goes through the seed box and the New game button, because whether those
 * are wired up is part of what this spec is for.
 */
async function recordThroughTheUi(
  page: Page,
  seed: string,
  attempts = 4,
): Promise<{ endTick: number; checkpoints: unknown }> {
  let shortest = Number.POSITIVE_INFINITY
  for (let attempt = 0; attempt < attempts; attempt++) {
    await page.fill("#cw2-seed", attempt === 0 ? seed : `${seed}-${attempt}`)
    await page.click('button[data-action="new-game"]')
    await playGreedily(page)
    // The snake may have died inside the play window, in which case the page
    // has already disabled Stop and clicking it would wait for an element
    // that is never going to be enabled again.
    const stop = page.locator('button[data-action="stop"]')
    if (await stop.isEnabled()) await stop.click()
    const session = await page.evaluate(() => ({
      endTick: window.__cw2test?.recording().endTick ?? 0,
      checkpoints: window.__cw2test?.checkpoints() ?? [],
    }))
    if (session.endTick > MIN_TICKS) return session
    shortest = Math.min(shortest, session.endTick)
  }
  throw new Error(
    `no session longer than ${MIN_TICKS} ticks in ${attempts} attempts (shortest ${shortest})`,
  )
}

test.describe("the demo's controls", () => {
  test("record, replay, and the panel says the hashes match", async ({
    page,
  }) => {
    await page.goto("/")
    await page.waitForFunction(() => window.__cw2test !== undefined)

    const recorded = await recordThroughTheUi(page, "e2e-ui")
    expect(recorded.endTick, "the session ran").toBeGreaterThan(MIN_TICKS)

    await page.click('button[data-action="replay"]')
    // Ten times speed, so a session of any length finishes inside the test.
    await page.locator("#cw2-speed").fill("10")
    await page.waitForFunction(
      () => window.__cw2test?.state().running === false,
      undefined,
      { timeout: 60_000 },
    )

    // Read the answer off the page, not out of the API.
    await expect(page.locator(".cw2-hash")).toContainText("identical")
    await expect(page.locator(".cw2-differ")).toHaveCount(0)
  })

  test("the speed slider changes how fast a replay runs, not where it ends", async ({
    page,
  }) => {
    await page.goto("/")
    await page.waitForFunction(() => window.__cw2test !== undefined)

    const recorded = await recordThroughTheUi(page, "e2e-ui-speed")
    expect(recorded.endTick).toBeGreaterThan(MIN_TICKS)

    await page.click('button[data-action="replay"]')
    await page.locator("#cw2-speed").fill("0.1")
    const slow = await ticksPer(page, 700)
    await page.locator("#cw2-speed").fill("10")
    const fast = await ticksPer(page, 700)

    // A tenth of real time against ten times it is a hundredfold in theory.
    // Five is the margin that survives a loaded CI machine, and the failure it
    // is here to catch - a slider wired to nothing - shows up as a ratio of 1.
    expect(fast, `slow ${slow}, fast ${fast}`).toBeGreaterThan(slow * 5)

    await page.waitForFunction(
      () => window.__cw2test?.state().running === false,
      undefined,
      { timeout: 60_000 },
    )
    const replayed = await page.evaluate(() => ({
      tick: window.__cw2test?.state().tick ?? 0,
      checkpoints: window.__cw2test?.checkpoints() ?? [],
    }))

    // Scrubbed mid-replay, and it still lands exactly where it was recorded.
    expect(replayed.tick).toBe(recorded.endTick)
    expect(replayed.checkpoints).toEqual(recorded.checkpoints)
  })
})
