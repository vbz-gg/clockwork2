/**
 * Running the probe bundle under one engine.
 */

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

const DRIVER = `${import.meta.dir}/browser-driver.mjs`

/**
 * How each engine is started.
 *
 * Every one of them is a child process fed the bundle on stdin, so there is
 * one way of running the probe rather than a runtime path and a browser path
 * that fail differently. The browsers used to be driven in process through
 * Playwright, which cannot work on Windows: bun does not carry through the
 * extra stdio descriptors --remote-debugging-pipe needs, so launch() hangs
 * until it times out. `browser-driver.mjs` carries the detail and the
 * upstream bugs.
 *
 * The browsers run under node for that reason alone. Keeping them there on
 * every platform means CI exercises one code path, not a Windows-only one
 * that nothing else would catch a break in.
 */
const COMMAND: Record<EngineId, readonly string[]> = {
  bun: ["bun", "run", "-"],
  node: ["node", "--input-type=module", "-"],
  chromium: ["node", DRIVER],
  firefox: ["node", DRIVER],
  webkit: ["node", DRIVER],
}

export async function runProbeOn(
  engine: EngineId,
  bundle: ProbeBundle,
  request: ProbeRequest,
): Promise<unknown> {
  const child = Bun.spawn(COMMAND[engine] as string[], {
    stdin: new TextEncoder().encode(bundle.source),
    stdout: "pipe",
    stderr: "pipe",
    env: {
      ...process.env,
      CW2_PROBE_REQUEST: JSON.stringify(request),
      CW2_PROBE_ENGINE: engine,
    },
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
