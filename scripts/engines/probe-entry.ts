/**
 * The entry the cross-engine bundle is built from.
 *
 * It exposes the probe on `globalThis` so a browser page can call it, and
 * runs itself when it finds a Node-shaped runtime, so the same bundle works
 * whether it is piped to `bun run -`, to `node --input-type=module -`, or
 * injected into a page.
 */

import {
  PROBE_VERSION,
  probeDetail,
  probeRange,
  probeVectorIds,
  runProbe,
} from "../../packages/engine/src/probe/index"

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
  | { readonly kind: "ids"; readonly heavy?: boolean }

export function dispatch(request: ProbeRequest): unknown {
  switch (request.kind) {
    case "run":
      return runProbe({
        ...(request.only === undefined ? {} : { only: request.only }),
        ...(request.heavy === undefined ? {} : { heavy: request.heavy }),
      })
    case "range":
      return probeRange(request.id, request.from, request.to)
    case "detail":
      return probeDetail(request.id, request.from, request.to)
    default:
      return probeVectorIds(
        request.heavy === undefined ? {} : { heavy: request.heavy },
      )
  }
}

export const SENTINEL = "__CW2_PROBE__"

const globals = globalThis as unknown as Record<string, unknown>
globals.__cw2probe = { dispatch, PROBE_VERSION, SENTINEL }

// Under a Node-shaped runtime, run straight away and print the answer. In a
// browser there is no process, and the page calls dispatch itself.
const maybeProcess = globals.process as
  | { env?: Record<string, string | undefined> }
  | undefined
if (maybeProcess?.env !== undefined) {
  const raw = maybeProcess.env.CW2_PROBE_REQUEST ?? '{"kind":"run"}'
  const answer = dispatch(JSON.parse(raw) as ProbeRequest)
  console.log(SENTINEL + JSON.stringify(answer))
}
