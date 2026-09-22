/**
 * The CLI, run as a process.
 *
 * `src/cli.ts` ends in `main(...).then((code) => process.exit(code))`, so
 * importing it into this file would run the CLI and exit the test runner. It is
 * spawned instead, which is also how anyone actually uses it. Coverage does not
 * follow a subprocess, which is why bunfig.toml leaves the file out of the
 * report and points here.
 *
 * What is worth pinning is the exit codes. A CI job gates on them, so a suite
 * that fails and exits 0 is worse than one that does not run.
 */

import { describe, expect, test } from "bun:test"
import { join } from "node:path"

const CLI = join(import.meta.dir, "../src/cli.ts")
const FIXTURES = join(import.meta.dir, "../fixtures")

async function run(
  ...args: string[]
): Promise<{ code: number; out: string; err: string }> {
  const proc = Bun.spawn(["bun", "run", CLI, ...args], {
    stdout: "pipe",
    stderr: "pipe",
  })
  const [out, err, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ])
  return { code, out, err }
}

describe("usage", () => {
  test("no arguments prints usage and exits 0", async () => {
    // Asking for help is not an error.
    const { code, out } = await run()
    expect(code).toBe(0)
    expect(out).toContain("clockwork2-validate")
    expect(out).toContain("run <path>")
    expect(out).toContain("scan <path>")
  }, 30_000)

  test("a command with no path exits 2", async () => {
    const { code, out } = await run("run")
    expect(code).toBe(2)
    expect(out).toContain("clockwork2-validate")
  }, 30_000)

  test("an unknown command exits 2 and names it", async () => {
    const { code, err } = await run("frobnicate", "./somewhere")
    expect(code).toBe(2)
    expect(err).toContain("unknown command frobnicate")
  }, 30_000)
})

describe("run", () => {
  test("a conforming game exits 0", async () => {
    const { code, out } = await run(
      "run",
      join(FIXTURES, "conforming"),
      "--only=manifest,budgets",
      "--seeds=t1",
    )
    expect(code).toBe(0)
    expect(out).toContain("all checks passed")
  }, 60_000)

  test("a non-conformant game exits 1 and names the code", async () => {
    const { code, out } = await run(
      "run",
      join(FIXTURES, "unbounded"),
      "--only=bound",
      "--seeds=t1",
    )
    expect(code).toBe(1)
    expect(out).toContain("E_BOUND_NOT_OVER")
  }, 60_000)

  test("--json prints a report another program can read", async () => {
    const { code, out } = await run(
      "run",
      join(FIXTURES, "unbounded"),
      "--only=bound",
      "--seeds=t1",
      "--json",
    )
    expect(code).toBe(1)
    const report = JSON.parse(out) as {
      ok: boolean
      outcomes: Array<{ check: string; findings: Array<{ code: string }> }>
    }
    expect(report.ok).toBe(false)
    expect(report.outcomes.map((o) => o.check)).toEqual(["bound"])
    expect(report.outcomes[0]?.findings[0]?.code).toBe("E_BOUND_NOT_OVER")
  }, 60_000)

  /**
   * `--only=a,b` is read by slicing past `--only=`. An off-by-one there would
   * silently run a check named ",determinism" or none at all, and the suite
   * would report a pass for work it never did.
   */
  test("--only takes every name after the equals sign", async () => {
    const { out } = await run(
      "run",
      join(FIXTURES, "conforming"),
      "--only=manifest,budgets,render-smoke",
      "--seeds=t1",
      "--json",
    )
    const report = JSON.parse(out) as { outcomes: Array<{ check: string }> }
    expect(report.outcomes.map((o) => o.check)).toEqual([
      "budgets",
      "manifest",
      "render-smoke",
    ])
  }, 60_000)

  test("--seeds takes every seed after the equals sign", async () => {
    const { out } = await run(
      "run",
      join(FIXTURES, "conforming"),
      "--only=replay",
      "--seeds=a1,b2",
      "--json",
    )
    const report = JSON.parse(out) as { outcomes: Array<{ note?: string }> }
    expect(report.outcomes[0]?.note).toBe("2 recordings")
  }, 60_000)

  test("a path that is not a bundle exits 3 rather than pretending to pass", async () => {
    const { code } = await run("run", join(FIXTURES, "no-such-bundle"))
    expect(code).toBe(3)
  }, 30_000)
})

describe("scan", () => {
  test("a clean file exits 0", async () => {
    const { code, out } = await run(
      "scan",
      join(FIXTURES, "conforming/index.ts"),
    )
    expect(code).toBe(0)
    expect(out).toContain("0 finding(s)")
    expect(out).toContain("platform package(s) trusted")
  }, 30_000)

  test("a file naming a banned API exits 1 and points at the line", async () => {
    const { code, out } = await run(
      "scan",
      join(FIXTURES, "banned-math/index.ts"),
    )
    expect(code).toBe(1)
    expect(out).toContain("index.ts:")
    expect(out).toMatch(/Math\.(random|sin|cos|pow)/)
  }, 30_000)
})
