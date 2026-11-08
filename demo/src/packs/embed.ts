/**
 * The platform's half for the pack game: embed it, start it, and end the run
 * a little after its demand pack is needed.
 *
 * What it received is written into the page, so the end-to-end suite reads it
 * with ordinary selectors.
 */

import { createGameFrame } from "@clockwork2/engine/parent"

const params = new URL(location.href).searchParams
const seed = params.get("seed") ?? "packs-seed"
const endAt = Number(params.get("end-at") ?? "420")
const delay = params.get("delay") ?? "600"
const stage = document.querySelector("#stage") as HTMLElement

function set(id: string, value: string): void {
  const node = document.querySelector(`#${id}`)
  if (node !== null) node.textContent = value
}

const chunks: string[] = []
let ending = false

const frame = createGameFrame({
  container: stage,
  src: `./packs-frame.html?parent=${encodeURIComponent(location.origin)}&delay=${delay}`,
  title: "Pack game",
  onReady: () => {
    set("phase", "ready")
    frame.init(seed, { prefetch: false }, 60, 3600)
    frame.start()
  },
  onStarted: () => set("phase", "running"),
  onProgress: (message) => {
    set("tick", String(message.tick))
    if (!ending && message.tick >= endAt) {
      ending = true
      frame.end()
    }
  },
  onEnded: (message) => {
    set("phase", "ended")
    set(
      "opened-at",
      String((message.finalSnapshot as { openedAt: number }).openedAt),
    )
  },
  onRecordingChunk: (message) => {
    chunks[message.index] = message.data
    if (chunks.filter((c) => c !== undefined).length === message.total) {
      set("recording", chunks.join(""))
      set("phase", "recorded")
    }
  },
  onError: (message) => set("error", `${message.code} ${message.detail}`),
})

document.querySelector("#push")?.addEventListener("click", () => {
  frame.virtualInput("push", 1)
})
