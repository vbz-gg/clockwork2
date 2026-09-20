/**
 * The end-to-end suite.
 *
 * Three decisions worth defending.
 *
 * `retries: 0`. For a determinism suite, flake *is* the finding. A retry that
 * turns red into green destroys the only signal the suite exists to produce.
 * Anything genuinely timing-sensitive is rewritten against the virtual clock
 * rather than retried.
 *
 * One worker, not parallel. Parallel workers contend for CPU, which stalls the
 * host loop and makes the real-clock specs behave unpredictably. These tests
 * are timing-sensitive by construction; there is no point fighting it.
 *
 * The production bundle is built and served, not the dev server. The dev
 * server injects hot reloading, transforms modules on the fly and has
 * different timing, and it is not what ships. The one exception is the test
 * hooks, which are built in behind a flag - and `00-smoke` checks that a build
 * without the flag really does drop them.
 */

import { existsSync } from "node:fs"
import { defineConfig, devices, type Project } from "@playwright/test"
import { chromium, firefox, webkit } from "playwright"

const REQUIRE_ALL = process.env.PW_REQUIRE_ALL === "1"

function installed(name: "chromium" | "firefox" | "webkit"): boolean {
  if (REQUIRE_ALL) return true
  const type = { chromium, firefox, webkit }[name]
  try {
    // Resolves a path without downloading, so a machine with one browser does
    // not fetch several hundred megabytes in the middle of a test run.
    return existsSync(type.executablePath())
  } catch {
    return false
  }
}

function projects(): Project[] {
  const wanted: Array<["chromium" | "firefox" | "webkit", string]> = [
    ["chromium", "Desktop Chrome"],
    ["firefox", "Desktop Firefox"],
    ["webkit", "Desktop Safari"],
  ]
  const out: Project[] = []
  for (const [name, device] of wanted) {
    if (!installed(name)) {
      console.warn(
        `SKIPPED  ${name}  not installed\n         fix: bunx playwright install ${name}`,
      )
      continue
    }
    out.push({ name, use: { ...devices[device] } })
  }
  if (out.length === 0) throw new Error("no browsers are installed")
  return out
}

export default defineConfig({
  testDir: "./specs",
  fullyParallel: false,
  workers: 1,
  retries: 0,
  forbidOnly: process.env.CI === "true",
  timeout: 120_000,
  expect: { timeout: 15_000 },
  reporter: [
    ["list"],
    ["html", { open: "never" }],
    ["json", { outputFile: "test-results/report.json" }],
  ],
  use: {
    baseURL: "http://127.0.0.1:4173",
    trace: "retain-on-failure",
    video: "retain-on-failure",
    screenshot: "only-on-failure",
  },
  webServer: {
    command: "bun run --cwd ../demo preview:test",
    url: "http://127.0.0.1:4173",
    reuseExistingServer: process.env.CI !== "true",
    timeout: 60_000,
    stdout: "ignore",
    stderr: "pipe",
  },
  projects: projects(),
})
