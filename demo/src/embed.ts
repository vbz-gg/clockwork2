/**
 * The platform's half: a page that embeds a game it does not trust.
 *
 * It does what an arcade does. It decides the seed, hands it over in `init`,
 * keeps every slice of the input log as it arrives, and reassembles the
 * recording at the end. It reads nothing out of the frame and calls nothing
 * inside it; the whole conversation is the message table.
 *
 * What it shows on the page is what it received, so the end-to-end suite can
 * read it with ordinary selectors rather than through a test hook.
 */

import type { InputEvent } from "@clockwork2/engine"
import { createGameFrame } from "@clockwork2/engine/parent"

const params = new URL(location.href).searchParams
const seed = params.get("seed") ?? "embedded-seed"
const stage = document.querySelector("#stage") as HTMLElement

function set(id: string, value: string): void {
  const node = document.querySelector(`#${id}`)
  if (node !== null) node.textContent = value
}

const order: string[] = []
const logInputs: InputEvent[] = []
const chunks: string[] = []
let checkpoints = 0
let logChunks = 0
let chunksBeforeEnded = 0
let ended = false
let total = 1

function note(type: string): void {
  order.push(type)
  set("order", order.join(" "))
}

const frame = createGameFrame({
  container: stage,
  // No seed here, and nothing else about the session either.
  src: `./frame.html?parent=${encodeURIComponent(location.origin)}`,
  title: "Snake",
  onReady: (message) => {
    note("ready")
    set("phase", "ready")
    set("manifest-hash", message.manifestHash)
    set("kernel-version", message.kernelVersion)
    frame.init(seed, null, 60, 60 * 60 * 5)
    set("seed-sent", seed)
    frame.start()
  },
  onStarted: () => {
    note("started")
    set("phase", "running")
  },
  onCheckpoint: () => {
    checkpoints++
    set("checkpoint-count", String(checkpoints))
  },
  onLogChunk: (message) => {
    // Arrives while the run is still going. A real platform stamps it with its
    // own clock here, which is what makes it evidence rather than a claim.
    if (message.fromIndex !== logInputs.length) {
      set("phase", "log-gap")
      return
    }
    logChunks++
    if (!ended) chunksBeforeEnded = logChunks
    logInputs.push(...message.inputs)
    set("log-chunk-count", String(logChunks))
    set("log-input-count", String(logInputs.length))
    set("chunks-before-ended", String(chunksBeforeEnded))
    note("log-chunk")
  },
  onEnded: (message) => {
    ended = true
    note("ended")
    set("phase", "ended")
    set("counters", JSON.stringify(message.counters))
  },
  onRecordingChunk: (message) => {
    total = message.total
    chunks[message.index] = message.data
    if (chunks.filter((part) => part !== undefined).length === total) {
      const node = document.querySelector("#recording")
      if (node !== null) node.textContent = chunks.join("")
      set("phase", "recorded")
    }
  },
  onError: (message) => {
    note("error")
    set("phase", `error ${message.code}`)
  },
})

for (const action of ["left", "right", "up", "down"]) {
  document.querySelector(`#${action}`)?.addEventListener("click", () => {
    // The only source of a virtual input is a control the host drew, which is
    // this one. The game cannot manufacture one.
    frame.virtualInput(action, 1)
  })
}
document.querySelector("#end")?.addEventListener("click", () => {
  frame.end()
})
