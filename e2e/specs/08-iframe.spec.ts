/**
 * The boundary a platform actually runs a stranger's game across.
 *
 * Everything else in this suite plays Snake on one page, where the host, the
 * simulation and the test share a window. A platform cannot do that: the game
 * is code somebody else wrote, so it goes in a frame with no same-origin
 * token, in an opaque origin, reachable only through the message table.
 *
 * Until this spec existed that whole path had no consumer anywhere in the
 * repository, and `docs/engine.md` described it as though it worked. What it
 * checks: the frame is really sandboxed, the seed arrives over the bridge
 * rather than in a URL, the input log reaches the host before the run is over,
 * and the recording that comes back replays on a server to the same state.
 */

import { execFileSync } from "node:child_process"
import { writeFileSync } from "node:fs"
import { expect, test } from "@playwright/test"

const ROOT = new URL("../../", import.meta.url).pathname
const TURNS = ["left", "up", "right", "down"]

async function textOf(
  page: import("@playwright/test").Page,
  id: string,
): Promise<string> {
  return (await page.locator(`#${id}`).textContent()) ?? ""
}

test.describe("a game in a sandboxed frame", () => {
  test("the frame is opaque to the page that embedded it", async ({ page }) => {
    await page.goto("/embed.html?seed=e2e-sandbox")
    await expect(page.locator("#phase")).toHaveText(/ready|running/)

    const reach = await page.evaluate(() => {
      const iframe = document.querySelector("iframe") as HTMLIFrameElement
      return {
        sandbox: iframe.getAttribute("sandbox"),
        // Both are null across an opaque origin. If either ever returns an
        // object the sandbox has been loosened and the game can read the page.
        document: iframe.contentDocument === null,
        src: iframe.getAttribute("src") ?? "",
      }
    })

    expect(reach.sandbox).toBe("allow-scripts")
    expect(reach.document).toBe(true)
    // The seed is session state. A seed in the frame's URL would be in the
    // referrer, the history entry and every log between here and the CDN.
    expect(reach.src).not.toContain("e2e-sandbox")
    expect(reach.src).not.toContain("seed")
  })

  test("the handshake runs in order and the seed comes from init", async ({
    page,
  }) => {
    await page.goto("/embed.html?seed=e2e-handshake")

    await expect(page.locator("#phase")).toHaveText(/running/)
    expect(await textOf(page, "manifest-hash")).toMatch(/^[0-9a-f]{16}$/)
    expect(await textOf(page, "kernel-version")).not.toBe("-")
    expect(await textOf(page, "seed-sent")).toBe("e2e-handshake")

    const order = (await textOf(page, "order")).split(" ")
    expect(order[0]).toBe("ready")
    expect(order[1]).toBe("started")
  })

  test("the log reaches the host before the run ends, and the run replays", async ({
    page,
  }, testInfo) => {
    await page.goto("/embed.html?seed=e2e-framed-run")
    await expect(page.locator("#phase")).toHaveText(/running/)

    // Steering from the host's own buttons, which is the only way a virtual
    // input may enter a session. Always a 90 degree turn, so the snake does
    // not die by reversing into itself.
    for (let i = 0; i < 14; i++) {
      await page.locator(`#${TURNS[i % TURNS.length]}`).click()
      await page.waitForTimeout(400)
      if ((await textOf(page, "phase")).startsWith("ended")) break
    }

    const chunksBeforeEnded = Number(await textOf(page, "chunks-before-ended"))
    await page.locator("#end").click()
    await expect(page.locator("#phase")).toHaveText("recorded")

    // The point of log-chunk: the host held part of the log at a moment it
    // could stamp itself, before the player knew how the run would go.
    expect(chunksBeforeEnded, "log chunks received mid-run").toBeGreaterThan(0)

    const order = (await textOf(page, "order")).split(" ")
    expect(order.indexOf("log-chunk")).toBeLessThan(order.indexOf("ended"))
    expect(order).not.toContain("error")

    const encoded = await textOf(page, "recording")
    expect(encoded.length, "a recording came back").toBeGreaterThan(0)
    const recording = JSON.parse(encoded) as {
      seed: string
      gameId: string
      endTick: number
      counters: Record<string, number>
      inputs: unknown[]
    }

    // What the host was told, and what the log it collected adds up to.
    expect(recording.seed).toBe("e2e-framed-run")
    expect(recording.gameId).toBe("clockwork2-snake")
    expect(recording.inputs.length).toBe(
      Number(await textOf(page, "log-input-count")),
    )
    expect(recording.inputs.length, "inputs recorded").toBeGreaterThan(0)
    expect(recording.endTick, "ticks simulated").toBeGreaterThan(60)

    // And the claim the frame made is one a server reproduces from the log.
    const file = testInfo.outputPath("framed-recording.json")
    writeFileSync(file, encoded)
    const replayed = execFileSync("bun", ["run", "scripts/replay.ts", file], {
      cwd: ROOT,
      encoding: "utf8",
    })
    await testInfo.attach("framed-recording.json", { path: file })
    await testInfo.attach("replay.txt", { body: replayed })

    expect(replayed).toContain(`endTick\t${recording.endTick}`)
    for (const [name, value] of Object.entries(recording.counters)) {
      expect(replayed, `counter ${name}`).toContain(`${name}\t${value}`)
    }
  })
})
