/**
 * The pack game inside a sandboxed frame.
 *
 * The bridge fetches the start pack from the frame's own address before it
 * says `ready`, and the host fetches the demand pack when the game names it.
 * Nothing about a pack travels in a message, and no message carries a URL.
 */

import { encodeRecording, RecordedInputSource } from "@clockwork2/engine"
import { connectToParent } from "@clockwork2/engine/frame"
import { GameHost } from "@clockwork2/engine/host"
import { FRAME_ERRORS } from "@clockwork2/engine/protocol"
import createGame, {
  MANIFEST,
  type PacksView,
} from "../../../packages/engine/fixtures/packs/index"
import { packLoader } from "./assets"

const params = new URL(location.href).searchParams
const parentOrigin = params.get("parent") ?? location.origin
const delayMs = Number(params.get("delay") ?? "0")

connectToParent<PacksView>({
  manifest: MANIFEST,
  parentOrigin,
  packs: packLoader(MANIFEST, delayMs),
  createHost: (init, bridge) => {
    const host: GameHost<PacksView, HTMLElement> = new GameHost({
      module: createGame(),
      manifest: MANIFEST,
      seed: init.seed,
      config: (init.config ?? {}) as never,
      maxTicks: init.maxTicks,
      checkpointEvery: 60,
      ...(init.packs === undefined ? {} : { packs: init.packs }),
      ...(init.inputs === undefined
        ? {}
        : { inputs: new RecordedInputSource(init.inputs) }),
      onCheckpoint: (checkpoint) => {
        bridge.checkpoint(checkpoint.tick, checkpoint.hash)
      },
      onFrame: (frame) => {
        const now = performance.now()
        bridge.progress(frame.tick, host.counters(), now)
        bridge.logChunk(now)
      },
      onEnded: (result) => {
        bridge.ended(result, encodeRecording(host.recording()))
      },
      onError: (error) => {
        bridge.error(
          FRAME_ERRORS.THREW,
          error instanceof Error ? error.message : String(error),
        )
      },
    })
    return host
  },
})
