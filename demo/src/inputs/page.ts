/**
 * Every device helper at once, on a page a spec can read.
 *
 * A `GameHost` runs the counting game in this page, and one `InputCapture`
 * maps every device it knows onto the game's inputs: keys, two pointer slots
 * with the right button on the first, hover, the mouse locked to the stage,
 * the wheel, whichever controller is connected first, and tilt. The stage is
 * a fixed 640 by 360, so a spec knows where each recorded position should
 * land.
 *
 * What the helpers recorded is written into the page as it happens: the log
 * as JSON, every device notice, whether the mouse is locked, and the answer
 * to asking for tilt. The end-to-end suite reads those with plain selectors
 * and never reaches into the page's modules.
 *
 * `?lock=off` leaves mouse lock out of the mapping. A spec about pointer
 * capture needs that: where a browser grants the lock, a press takes the
 * mouse into it, and a locked mouse cannot leave the stage to show that a
 * release outside it still arrives.
 */

import { assertManifest, type InputEvent } from "@clockwork2/engine"
import {
  type CaptureMapping,
  type DeviceNotice,
  GameHost,
  InputCapture,
  requestMotion,
} from "@clockwork2/engine/host"
import { createGame, type InputsView, MANIFEST } from "./game"

const params = new URL(location.href).searchParams
const stage = document.querySelector("#stage") as HTMLElement

/** Which device drives which input: the game's choice, not the manifest's. */
const UNLOCKED: CaptureMapping = {
  keys: {
    ArrowLeft: "left",
    KeyA: "left",
    ArrowRight: "right",
    KeyD: "right",
    Space: "jump",
  },
  pointers: [
    { down: "touch", x: "touchX", y: "touchY", buttons: { 2: "alt" } },
    { down: "touch2", x: "touch2X", y: "touch2Y" },
  ],
  hover: { x: "hoverX", y: "hoverY" },
  wheel: { y: "zoom" },
  gamepads: {
    any: {
      buttons: { 0: "padA" },
      values: { 7: "padTrigger" },
      axes: { 0: "padX", 1: "padY" },
    },
  },
  tilt: { x: "tiltX", y: "tiltY", z: "tiltZ" },
}

const MAPPING: CaptureMapping = {
  ...UNLOCKED,
  mouseLock: { dx: "lookX", dy: "lookY" },
}

function set(id: string, value: string): void {
  const node = document.querySelector(`#${id}`)
  if (node !== null) node.textContent = value
}

const notices: DeviceNotice[] = []
let shown = -1

function showLog(log: readonly InputEvent[]): void {
  if (log.length === shown) return
  shown = log.length
  set("count", String(log.length))
  set("log", JSON.stringify(log))
}

function start(): void {
  assertManifest(MANIFEST)
  const mapping = params.get("lock") === "off" ? UNLOCKED : MAPPING
  set("lock-mapped", mapping.mouseLock === undefined ? "no" : "yes")

  const host = new GameHost<InputsView>({
    module: createGame(),
    manifest: MANIFEST,
    seed: params.get("seed") ?? "inputs",
    onFrame: (frame) => {
      set("tick", String(frame.tick))
      showLog(host.live?.recorded() ?? [])
    },
    onEnded: () => {
      set("phase", "ended")
    },
    onError: (error) => {
      set("error", error instanceof Error ? error.message : String(error))
    },
  })
  const queue = host.live
  if (queue === null) throw new Error("a live session has a live queue")

  const capture = new InputCapture({
    manifest: MANIFEST,
    queue,
    element: stage,
    ...mapping,
    onNotice: (notice) => {
      notices.push(notice)
      set("notices", JSON.stringify(notices))
    },
  })
  capture.attach()

  // What the browser says about the lock, beside what the helper reports, so
  // a spec can tell a lock that was refused from one that was never asked.
  let lockErrors = 0
  document.addEventListener("pointerlockchange", () => {
    set("locked", document.pointerLockElement === stage ? "yes" : "no")
  })
  document.addEventListener("pointerlockerror", () => {
    lockErrors++
    set("lock-errors", String(lockErrors))
  })

  // Tilt is asked for first thing in a click, before anything is awaited,
  // which is the only way iOS shows its prompt.
  document.querySelector("#motion")?.addEventListener("click", () => {
    void requestMotion().then((access) => {
      set("motion-access", JSON.stringify(access))
    })
  })

  host.start()
  set("phase", "running")
}

try {
  start()
} catch (error) {
  set("error", error instanceof Error ? error.message : String(error))
}
