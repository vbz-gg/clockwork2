/**
 * The pack game with its simulation in a real worker.
 *
 * The page fetches the start pack before it starts the worker, and transfers
 * it with `init`; the demand pack goes over when the worker says it is
 * holding for it. The page runs four times faster than real time, which
 * changes how many ticks a frame runs and nothing else, so the whole run
 * fits in a few seconds.
 */

import { loadPacks } from "@clockwork2/engine/host"
import { WorkerSimulation } from "@clockwork2/engine/worker"
import { MANIFEST } from "../../../packages/engine/fixtures/packs/index"
import { packLoader } from "./assets"

const params = new URL(location.href).searchParams
const seed = params.get("seed") ?? "packs-worker-seed"
const delay = Number(params.get("delay") ?? "600")
const SPEED = 4

function set(id: string, value: string): void {
  const node = document.querySelector(`#${id}`)
  if (node !== null) node.textContent = value
}

const checkpoints: Array<{ tick: number; hash: string }> = []
let tick = 0
let openedAt = -1
let heldFrames = 0
let pending = 0
let done = false

const loader = packLoader(MANIFEST, delay)
const preloaded = await loadPacks(MANIFEST, loader, "start")
const sim = new WorkerSimulation({
  worker: new Worker(new URL("./worker.ts", import.meta.url), {
    type: "module",
  }),
  seed,
  config: { prefetch: false },
  packs: { preloaded, loader },
  onFrame: (frame) => {
    if (frame.tick === tick && frame.running && tick === 300) heldFrames++
    tick = frame.tick
    openedAt = (frame.view as { openedAt: number }).openedAt
    set("tick", String(tick))
  },
  onCheckpoint: (checkpoint) => checkpoints.push(checkpoint),
  onEnded: (result) => {
    done = true
    set(
      "result",
      JSON.stringify({
        seed,
        config: { prefetch: false },
        endTick: result.endTick,
        counters: result.counters,
        inputs: result.inputs,
        checkpoints,
        openedAt,
        heldFrames,
      }),
    )
    set("phase", "ended")
  },
  onError: (detail, code) => set("error", `${code ?? ""} ${detail}`),
})
set("phase", "running")

document.querySelector("#push")?.addEventListener("click", () => {
  pending++
})

let last = performance.now()
function frame(now: number): void {
  if (done) return
  if (pending > 0) {
    sim.send(
      Array.from({ length: pending }, () => ({
        device: "virtual" as const,
        code: "push",
        value: 1,
      })),
    )
    pending = 0
  }
  sim.frame((now - last) * SPEED)
  last = now
  requestAnimationFrame(frame)
}
requestAnimationFrame(frame)
