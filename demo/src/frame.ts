/**
 * The game document, as a platform embeds it.
 *
 * This page is what runs inside `sandbox="allow-scripts"` with no
 * `allow-same-origin`: an opaque origin with no storage, no cookies and no
 * reach into the page that framed it. It waits for `init` before it builds
 * anything, so the seed arrives over the bridge rather than in this URL, where
 * it would end up in a referrer and a server log.
 *
 * The only thing the URL carries is which origin to talk to, which is not a
 * secret and which a real deployment would bake in per platform instead.
 */

import { connectToParent, encodeRecording } from "@clockwork2/engine/frame"
import { GameHost, InputCapture } from "@clockwork2/engine/host"
import { FRAME_ERRORS } from "@clockwork2/engine/protocol"
import {
  createGame,
  DEFAULT_CONFIG,
  MANIFEST,
  type SnakeConfig,
  type SnakeView,
} from "./game/index"
import { createSnakePresentation } from "./present/pixi"

const params = new URL(location.href).searchParams
const parentOrigin = params.get("parent") ?? location.origin
const container = document.querySelector("#stage") as HTMLElement

connectToParent<SnakeView>({
  manifest: MANIFEST,
  parentOrigin,
  createHost: (init, bridge) => {
    const host = new GameHost<SnakeView, HTMLElement, SnakeConfig>({
      module: createGame(),
      manifest: MANIFEST,
      seed: init.seed,
      config: (init.config as SnakeConfig | null) ?? DEFAULT_CONFIG,
      presentation: createSnakePresentation(),
      container,
      checkpointEvery: 60,
      maxTicks: init.maxTicks,
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
    // Device input is captured here, inside the frame, from real events. The
    // game cannot build an input of its own, and the parent can only send the
    // virtual kind, from a control it drew itself.
    new InputCapture({ manifest: MANIFEST, queue: host.live as never }).attach()
    return host
  },
})
