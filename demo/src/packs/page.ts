/**
 * The pack game, played in this page: the start pack fetched before the run
 * begins, the demand pack when the game names it, and the run ended a little
 * after its demand pack is needed.
 *
 * The page's Push button records the game's one input directly, a press and
 * a release, the way a game's own page records what its controls did. What
 * the run produced is written into the page, so the end-to-end suite reads
 * it with ordinary selectors.
 */

import { encodeRecording } from "@clockwork2/engine"
import { GameHost, loadPacks } from "@clockwork2/engine/host"
import createGame, {
  MANIFEST,
  type PacksView,
} from "../../../packages/engine/fixtures/packs/index"
import { packLoader } from "./assets"

const params = new URL(location.href).searchParams
const seed = params.get("seed") ?? "packs-seed"
const endAt = Number(params.get("end-at") ?? "420")
const delayMs = Number(params.get("delay") ?? "600")
const stage = document.querySelector("#stage") as HTMLElement

function set(id: string, value: string): void {
  const node = document.querySelector(`#${id}`)
  if (node !== null) node.textContent = value
}

const loader = packLoader(MANIFEST, delayMs)
const preloaded = await loadPacks(MANIFEST, loader, "start")
let ending = false

const host: GameHost<PacksView, HTMLElement> = new GameHost({
  module: createGame(),
  manifest: MANIFEST,
  seed,
  config: { prefetch: false } as never,
  container: stage,
  maxTicks: 3600,
  checkpointEvery: 60,
  packs: { preloaded, loader },
  onFrame: (frame) => {
    set("tick", String(frame.tick))
    if (!ending && frame.tick >= endAt) {
      ending = true
      host.stop()
    }
  },
  onEnded: (result) => {
    set("phase", "ended")
    set("opened-at", String((result.snapshot as { openedAt: number }).openedAt))
    set("recording", encodeRecording(host.recording()))
    set("phase", "recorded")
  },
  onError: (error) => {
    set("error", error instanceof Error ? error.message : String(error))
  },
})

document.querySelector("#push")?.addEventListener("click", () => {
  host.live?.push({ code: "push", value: 1 })
  host.live?.push({ code: "push", value: 0 })
})

host.start()
set("phase", "running")
