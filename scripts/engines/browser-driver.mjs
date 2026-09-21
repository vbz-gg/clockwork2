/**
 * Runs the probe bundle in one browser and prints the answer.
 *
 * This is the one file in the harness that node runs rather than bun, and it
 * is plain JavaScript for the same reason: node has to execute it with no
 * build step in front of it.
 *
 * It exists because bun cannot drive Playwright on Windows. Playwright talks
 * to the browser over --remote-debugging-pipe, which hands the child two
 * stdio descriptors beyond the usual three, and bun on Windows does not carry
 * them through: the browser starts, is given a pid, and never answers the
 * handshake, so launch() times out after 180s. See oven-sh/bun#27977 and
 * microsoft/playwright#42801. Every `sweep (windows-latest)` run of the
 * cross-engine matrix failed that way, on both windows-2025-vs2026 and
 * windows-2022, and with the headless shell and the full chromium build
 * alike. Linux and macOS finish the same step in under 11s, which is why it
 * went unseen until the matrix was added.
 *
 * The parent passes the bundle on stdin and the rest in the environment, the
 * same way it feeds `bun run -` and `node --input-type=module -`.
 */

import { chromium, firefox, webkit } from "playwright"

const SENTINEL = "__CW2_PROBE__"
const BROWSERS = { chromium, firefox, webkit }

function readStdin() {
  return new Promise((resolve, reject) => {
    let text = ""
    process.stdin.setEncoding("utf8")
    process.stdin.on("data", (chunk) => {
      text += chunk
    })
    process.stdin.on("end", () => resolve(text))
    process.stdin.on("error", reject)
  })
}

const name = process.env.CW2_PROBE_ENGINE
const browserType = BROWSERS[name]
if (browserType === undefined) {
  throw new Error(`browser-driver: unknown engine ${String(name)}`)
}

const source = await readStdin()
const request = process.env.CW2_PROBE_REQUEST ?? '{"kind":"run"}'

const browser = await browserType.launch()
try {
  const page = await browser.newPage()
  // about:blank is enough. No server, no fixture, nothing else to go wrong.
  await page.goto("about:blank")
  await page.addScriptTag({ content: source })
  const answer = await page.evaluate((payload) => {
    const probe = globalThis.__cw2probe
    return probe.dispatch(JSON.parse(payload))
  }, request)
  process.stdout.write(`${SENTINEL}${JSON.stringify(answer)}\n`)
} finally {
  await browser.close()
}
