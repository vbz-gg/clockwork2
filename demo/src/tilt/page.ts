/**
 * A page for checking tilt by hand, on a real phone.
 *
 * The counting game from the inputs page runs here with one mapping: tilt
 * onto its three signed axes, each the direction of gravity across the screen
 * times 100, so x is to the right, y is up the screen and z is out of it. The
 * page shows the browser's own reading beside what the helper recorded, and
 * draws a dot where gravity points, which sits at the lowest point of the box
 * whenever the signs and the screen rotation are right.
 *
 * Tilt is unverified on real phones until somebody holds one, which is what
 * this page is for. A browser spec checks that it runs, under Chromium's
 * orientation override.
 */

import { assertManifest, type InputEvent } from "@clockwork2/engine"
import {
  type DeviceNotice,
  GameHost,
  InputCapture,
  requestMotion,
} from "@clockwork2/engine/host"
import { createGame, type InputsView, MANIFEST } from "../inputs/game"

const field = document.querySelector("#field") as HTMLElement
const dot = document.querySelector("#dot") as HTMLElement

function set(id: string, value: string): void {
  const node = document.querySelector(`#${id}`)
  if (node !== null) node.textContent = value
}

/** The last recorded value of each tilt axis, or 0 before one arrives. */
function latest(log: readonly InputEvent[]): {
  x: number
  y: number
  z: number
} {
  const last = { x: 0, y: 0, z: 0 }
  for (const input of log) {
    if (input.code === "tiltX") last.x = input.value
    else if (input.code === "tiltY") last.y = input.value
    else if (input.code === "tiltZ") last.z = input.value
  }
  return last
}

function start(): void {
  assertManifest(MANIFEST)
  const notices: DeviceNotice[] = []
  let shown = -1
  const host = new GameHost<InputsView>({
    module: createGame(),
    manifest: MANIFEST,
    seed: "tilt",
    onFrame: () => {
      const log = host.live?.recorded() ?? []
      if (log.length === shown) return
      shown = log.length
      const { x, y, z } = latest(log)
      set("recorded", `${x}, ${y}, ${z}`)
      set("count", String(log.length))
      // Gravity across the screen, x right and y up, so the dot falls to
      // wherever down is.
      dot.style.left = `${50 + x / 2.2}%`
      dot.style.top = `${50 - y / 2.2}%`
    },
    onError: (error) => {
      set("error", error instanceof Error ? error.message : String(error))
    },
  })
  const queue = host.live
  if (queue === null) throw new Error("a live session has a live queue")
  new InputCapture({
    manifest: MANIFEST,
    queue,
    element: field,
    tilt: { x: "tiltX", y: "tiltY", z: "tiltZ" },
    onNotice: (notice) => {
      notices.push(notice)
      set("notices", JSON.stringify(notices))
    },
  }).attach()

  // The browser's reading, and how often it arrives, beside the recording.
  let readings = 0
  window.addEventListener("deviceorientation", (event) => {
    readings++
    const beta = event.beta === null ? "null" : event.beta.toFixed(1)
    const gamma = event.gamma === null ? "null" : event.gamma.toFixed(1)
    set("raw", `${beta}, ${gamma}`)
  })
  setInterval(() => {
    set("rate", String(readings))
    readings = 0
    set("angle", String(screen.orientation?.angle ?? "none"))
  }, 1000)

  // First thing in the tap, before anything is awaited: iOS asks only then.
  document.querySelector("#allow")?.addEventListener("click", () => {
    void requestMotion().then((access) => {
      set("answer", JSON.stringify(access))
    })
  })

  host.start()
}

try {
  start()
} catch (error) {
  set("error", error instanceof Error ? error.message : String(error))
}
