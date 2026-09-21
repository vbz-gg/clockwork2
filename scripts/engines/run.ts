/**
 * Running the probe bundle under one engine.
 */

import type { LaunchOptions } from "playwright"
import type { ProbeBundle } from "./build"
import type { EngineId } from "./detect"

export interface ProbeVector {
  readonly id: string
  readonly count: number
  readonly digest: string
  readonly head: readonly string[]
}

export interface ProbeAnswer {
  readonly probeVersion: number
  readonly vectors: readonly ProbeVector[]
}

export type ProbeRequest =
  | {
      readonly kind: "run"
      readonly only?: readonly string[]
      readonly heavy?: boolean
    }
  | {
      readonly kind: "range"
      readonly id: string
      readonly from: number
      readonly to: number
    }
  | {
      readonly kind: "detail"
      readonly id: string
      readonly from: number
      readonly to: number
    }

const SENTINEL = "__CW2_PROBE__"

function extract(output: string, engine: EngineId): unknown {
  const at = output.lastIndexOf(SENTINEL)
  if (at < 0) {
    throw new Error(
      `${engine} printed no probe result:\n${output.slice(0, 2000)}`,
    )
  }
  const line = output.slice(at + SENTINEL.length).split("\n")[0] as string
  return JSON.parse(line)
}

async function runInRuntime(
  engine: "bun" | "node",
  bundle: ProbeBundle,
  request: ProbeRequest,
): Promise<unknown> {
  const command =
    engine === "bun"
      ? ["bun", "run", "-"]
      : ["node", "--input-type=module", "-"]
  const child = Bun.spawn(command, {
    stdin: new TextEncoder().encode(bundle.source),
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env, CW2_PROBE_REQUEST: JSON.stringify(request) },
  })
  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ])
  if (code !== 0) {
    throw new Error(`${engine} exited with ${code}:\n${stderr.slice(0, 2000)}`)
  }
  return extract(stdout, engine)
}

/**
 * Playwright's default headless chromium is a separate headless-shell binary.
 * On the windows-2025-vs2026 runner it starts - a pid is assigned - and never
 * completes the --remote-debugging-pipe handshake, so launch() times out after
 * 180s and the sweep never reaches a digest. `channel: "chromium"` runs the
 * full chromium build with --headless=new instead, which is also the binary
 * detect.ts probes with executablePath().
 */
const LAUNCH: Record<"chromium" | "firefox" | "webkit", LaunchOptions> = {
  chromium: { channel: "chromium" },
  firefox: {},
  webkit: {},
}

async function runInBrowser(
  engine: "chromium" | "firefox" | "webkit",
  bundle: ProbeBundle,
  request: ProbeRequest,
): Promise<unknown> {
  const playwright = await import("playwright")
  const browser = await playwright[engine].launch(LAUNCH[engine])
  try {
    const page = await browser.newPage()
    // about:blank is enough. No server, no fixture, nothing else to go wrong.
    await page.goto("about:blank")
    await page.addScriptTag({ content: bundle.source })
    return await page.evaluate((payload: string) => {
      const probe = (globalThis as unknown as Record<string, unknown>)
        .__cw2probe as {
        dispatch: (request: unknown) => unknown
      }
      return probe.dispatch(JSON.parse(payload))
    }, JSON.stringify(request))
  } finally {
    await browser.close()
  }
}

export async function runProbeOn(
  engine: EngineId,
  bundle: ProbeBundle,
  request: ProbeRequest,
): Promise<unknown> {
  if (engine === "bun" || engine === "node") {
    return runInRuntime(engine, bundle, request)
  }
  return runInBrowser(engine, bundle, request)
}
