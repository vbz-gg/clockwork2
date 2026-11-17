/**
 * The page entry: the only file that knows a browser exists.
 *
 * It wires four things together and owns none of them - a module, a manifest,
 * a presentation and a container. The loop and the recording come from the
 * host, which keys drive which input is decided here, and the simulation
 * knows about none of it.
 */

import { encodeRecording } from "@clockwork2/engine"
import { GameHost, InputCapture } from "@clockwork2/engine/host"
import createGame, {
  type Config,
  DEFAULT_CONFIG,
  MANIFEST,
  type View,
} from "./index"
import { createPresentation } from "./present"

const container = document.querySelector("#game") as HTMLElement
const seed = new URL(location.href).searchParams.get("seed") ?? "demo-seed"

const host = new GameHost<View, HTMLElement, Config>({
  module: createGame(),
  manifest: MANIFEST,
  seed,
  config: DEFAULT_CONFIG,
  presentation: createPresentation(),
  container,
  checkpointEvery: MANIFEST.session.tickHz,
  onEnded: (result) => {
    // The recording is what the platform verifies. Nothing else a client
    // sends about a session is trusted, and nothing else needs to be.
    console.log("ended", result.terminal, result.counters)
    console.log(encodeRecording(host.recording()).length, "bytes of recording")
  },
})

// Only a replay has no live queue, and this page never replays.
const live = host.live
if (live === null) throw new Error("a live session has a live input queue")

// Which keys press the game's inputs is this page's choice; the manifest
// only says what is recorded. Only the player's own keys drive it: an event a
// script dispatches is ignored, as a ranked run on a platform requires.
new InputCapture({
  manifest: MANIFEST,
  queue: live,
  scripted: "ignore",
  keys: { ArrowLeft: "left", KeyA: "left", ArrowRight: "right", KeyD: "right" },
}).attach()
host.start()
