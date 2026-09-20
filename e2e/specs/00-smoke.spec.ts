import { expect, test } from "@playwright/test"

test.describe("the demo loads", () => {
  test("draws a canvas and starts running", async ({ page }) => {
    await page.goto("/")
    await expect(page.locator("canvas")).toBeVisible()
    await page.waitForFunction(() => window.__cw2test !== undefined)
    // It is actually simulating, not merely present.
    const first = await page.evaluate(() => window.__cw2test?.state().tick ?? 0)
    await page.waitForTimeout(500)
    const second = await page.evaluate(
      () => window.__cw2test?.state().tick ?? 0,
    )
    expect(second).toBeGreaterThan(first)
  })

  test("the test hooks are behind a build flag", async ({ page }) => {
    // The suite runs against a build made with VITE_CW2_TEST=1, so the hooks
    // are here. That a build *without* the flag drops them is checked by
    // scripts/check-no-test-hooks.ts, which greps the built output.
    await page.goto("/")
    await page.waitForFunction(() => window.__cw2test !== undefined)
    expect(await page.evaluate(() => window.__cw2test?.apiVersion)).toBe(1)
  })
})
