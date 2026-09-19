/**
 * Which engines this machine can run.
 *
 * Browser detection asks Playwright where it *would* find the browser and
 * checks whether anything is there. That call resolves a path without
 * downloading, so a machine with only Chromium reports the other two as
 * missing instead of fetching several hundred megabytes in the middle of a
 * test run.
 */

import { existsSync } from "node:fs"
import type { BrowserType } from "playwright"

export type EngineId = "bun" | "node" | "chromium" | "firefox" | "webkit"
export type JsEngine = "JavaScriptCore" | "V8" | "SpiderMonkey"

export interface EngineAvailability {
  readonly id: EngineId
  readonly jsEngine: JsEngine
  readonly kind: "runtime" | "browser"
  readonly available: boolean
  readonly hint?: string
}

const INSTALL_HINT =
  "bunx playwright install <name> (PLAYWRIGHT_BROWSERS_PATH is respected)"

export async function detectEngines(): Promise<readonly EngineAvailability[]> {
  const out: EngineAvailability[] = [
    {
      id: "bun",
      jsEngine: "JavaScriptCore",
      kind: "runtime",
      available: Bun.which("bun") !== null,
      hint: "https://bun.sh",
    },
    {
      id: "node",
      jsEngine: "V8",
      kind: "runtime",
      available: Bun.which("node") !== null,
      hint: "install Node 22 or later",
    },
  ]

  let playwright: typeof import("playwright") | null = null
  try {
    playwright = await import("playwright")
  } catch {
    playwright = null
  }

  const browsers: Array<[EngineId, JsEngine, BrowserType | undefined]> = [
    ["chromium", "V8", playwright?.chromium],
    ["firefox", "SpiderMonkey", playwright?.firefox],
    ["webkit", "JavaScriptCore", playwright?.webkit],
  ]

  for (const [id, jsEngine, browserType] of browsers) {
    let available = false
    if (browserType !== undefined) {
      try {
        available = existsSync(browserType.executablePath())
      } catch {
        available = false
      }
    }
    out.push({
      id,
      jsEngine,
      kind: "browser",
      available,
      hint: playwright === null ? "playwright is not installed" : INSTALL_HINT,
    })
  }

  return out
}
