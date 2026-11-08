/**
 * Data packs in a real browser.
 *
 * The unit suite proves the hosts agree using a fake frame and a fake worker,
 * and both of the host bugs found while this was designed would have passed
 * there: a frame that downloads before it listens misses the parent's one
 * hello, and a page that transfers a buffer it shares empties its own cache.
 * Here the frame is really sandboxed and fetches from its own address across
 * an opaque origin, and the worker is a real one that receives transferred
 * buffers. Each run holds for its demand pack, which the page delays, and
 * each replays on a server to the same checkpoints with the pack read at the
 * same tick.
 */

import { execFileSync } from "node:child_process"
import { writeFileSync } from "node:fs"
import { expect, type Page, type TestInfo, test } from "@playwright/test"

const ROOT = new URL("../../", import.meta.url).pathname
/** The tick from which the fixture game needs its demand pack. */
const LEVEL_FROM = 300

type Replay = {
  endTick: number
  counters: Record<string, number>
  checkpoints: Array<{ tick: number; hash: string }>
  openedAt: number
}

function replay(testInfo: TestInfo, name: string, body: string): Replay {
  const file = testInfo.outputPath(`${name}.json`)
  writeFileSync(file, body)
  const out = execFileSync("bun", ["e2e/fixtures/replay-packs.ts", file], {
    cwd: ROOT,
    encoding: "utf8",
  })
  return JSON.parse(out) as Replay
}

async function push(page: Page, times: number): Promise<void> {
  for (let i = 0; i < times; i++) {
    await page.locator("#push").click()
    await page.waitForTimeout(150)
  }
}

test.describe("data packs in a browser", () => {
  test("a sandboxed frame fetches its packs, holds for one, and replays", async ({
    page,
  }, testInfo) => {
    await page.goto("/packs-embed.html?seed=e2e-packs-frame&delay=600")
    await expect(page.locator("#phase")).toHaveText(/running/)
    await push(page, 4)
    await expect(page.locator("#phase")).toHaveText("recorded", {
      timeout: 60_000,
    })
    expect(await page.locator("#error").textContent()).toBe("")

    const encoded = (await page.locator("#recording").textContent()) ?? ""
    const recording = JSON.parse(encoded) as {
      seed: string
      config: unknown
      inputs: unknown[]
      endTick: number
      counters: Record<string, number>
      checkpoints: Array<{ tick: number; hash: string }>
      hostStats: { droppedMs: number }
    }
    // Guards: the run recorded the presses, went past the tick that needs
    // the level, and the loop really held while the level was delayed.
    expect(recording.inputs.length).toBeGreaterThan(0)
    expect(recording.endTick).toBeGreaterThan(LEVEL_FROM + 60)
    expect(recording.hostStats.droppedMs).toBeGreaterThan(400)
    expect(await page.locator("#opened-at").textContent()).toBe(
      String(LEVEL_FROM),
    )

    const replayed = replay(testInfo, "framed-packs", encoded)
    expect(replayed.openedAt).toBe(LEVEL_FROM)
    expect(replayed.endTick).toBe(recording.endTick)
    expect(replayed.counters).toEqual(recording.counters)
    expect(replayed.checkpoints).toEqual(recording.checkpoints)
  })

  test("a real worker receives its packs as transferred buffers, holds, and replays", async ({
    page,
  }, testInfo) => {
    await page.goto("/packs-worker.html?seed=e2e-packs-worker&delay=600")
    await expect(page.locator("#phase")).toHaveText(/running/)
    await push(page, 4)
    await expect(page.locator("#phase")).toHaveText("ended", {
      timeout: 60_000,
    })
    expect(await page.locator("#error").textContent()).toBe("")

    const body = (await page.locator("#result").textContent()) ?? ""
    const result = JSON.parse(body) as {
      endTick: number
      counters: Record<string, number>
      inputs: unknown[]
      checkpoints: Array<{ tick: number; hash: string }>
      openedAt: number
      heldFrames: number
    }
    expect(result.inputs.length).toBeGreaterThan(0)
    expect(result.heldFrames).toBeGreaterThan(5)
    expect(result.openedAt).toBe(LEVEL_FROM)

    const replayed = replay(testInfo, "worker-packs", body)
    expect(replayed.openedAt).toBe(LEVEL_FROM)
    expect(replayed.endTick).toBe(result.endTick)
    expect(replayed.counters).toEqual(result.counters)
    expect(replayed.checkpoints).toEqual(result.checkpoints)
  })
})
