/**
 * Browser to disk to two server runtimes.
 *
 * This is the platform's actual claim in one test: the browser records, the
 * server replays, and both reach the same state. Everything else in the suite
 * is a component of it.
 */

import { execFileSync } from "node:child_process"
import { readFileSync, writeFileSync } from "node:fs"
import { expect, test } from "@playwright/test"
import { payload, playGreedily } from "./support"

const ROOT = new URL("../../", import.meta.url).pathname

/** The same shape `scripts/replay.ts` prints, so a mismatch is a small diff. */
function asText(result: {
  checkpoints: ReadonlyArray<{ tick: number; hash: string }>
  endTick: number
  terminal: string
  counters: Readonly<Record<string, number>>
}): string {
  const lines = result.checkpoints.map((c) => `${c.tick}\t${c.hash}`)
  lines.push(`endTick\t${result.endTick}`)
  lines.push(`terminal\t${result.terminal}`)
  for (const name of Object.keys(result.counters).sort()) {
    lines.push(`${name}\t${String(result.counters[name])}`)
  }
  return `${lines.join("\n")}\n`
}

test.describe("a browser recording replays on a server", () => {
  test("bun and node reach the same state the browser did", async ({
    page,
  }, testInfo) => {
    await page.goto("/")
    await page.waitForFunction(() => window.__cw2test !== undefined)
    await page.evaluate(() => {
      window.__cw2test?.reset("e2e-cross")
    })

    // Real key events, at times nobody controls, from a player that lasts.
    await playGreedily(page, 8)
    await page.evaluate(() => {
      window.__cw2test?.stop()
    })

    const recording = await page.evaluate(() => window.__cw2test?.recording())
    const inBrowser = await page.evaluate(
      (input) =>
        window.__cw2test?.runFixedLog(input as never, {
          kind: "fixed",
          ms: 1000 / 60,
        }),
      payload(recording),
    )
    expect(recording?.inputs.length ?? 0).toBeGreaterThan(8)
    expect(recording?.endTick ?? 0).toBeGreaterThan(200)

    // Somewhere the report can attach it, so a red run is reproducible from
    // one downloaded artifact.
    const file = testInfo.outputPath("recording.json")
    writeFileSync(file, JSON.stringify(recording))

    const fromBun = execFileSync("bun", ["run", "scripts/replay.ts", file], {
      cwd: ROOT,
      encoding: "utf8",
    })
    const fromNode = execFileSync("node", ["test-results/replay.mjs", file], {
      cwd: ROOT,
      encoding: "utf8",
    })
    const fromBrowser = asText(inBrowser as never)

    await testInfo.attach("recording.json", { path: file })
    await testInfo.attach("browser.txt", { body: fromBrowser })
    await testInfo.attach("bun.txt", { body: fromBun })
    await testInfo.attach("node.txt", { body: fromNode })

    expect(fromBun).toBe(fromBrowser)
    expect(fromNode).toBe(fromBrowser)
  })

  test("a frozen fixture replays the same in the browser as on disk", async ({
    page,
  }) => {
    // The fixture was recorded on an older build, which is what makes it worth
    // keeping: a change that moves both the recorder and the replayer stays
    // invisible to a record-and-replay test and is caught here.
    await page.goto("/")
    await page.waitForFunction(() => window.__cw2test !== undefined)

    const recording = JSON.parse(
      readFileSync(
        new URL("../fixtures/snake-02.json", import.meta.url),
        "utf8",
      ),
    ) as Record<string, unknown>
    const expected = readFileSync(
      new URL("../fixtures/snake-02.checkpoints.txt", import.meta.url),
      "utf8",
    )

    const inBrowser = await page.evaluate(
      (input) =>
        window.__cw2test?.runFixedLog(input as never, {
          kind: "fixed",
          ms: 1000 / 60,
        }),
      payload(recording),
    )
    // The recording was stopped, so a replay reaches its end tick by the cap
    // rather than by dying; everything else has to match line for line.
    const actual = asText(inBrowser as never).replace(/^terminal\t.*$/m, "")
    expect(actual).toBe(expected.replace(/^terminal\t.*$/m, ""))
  })
})
