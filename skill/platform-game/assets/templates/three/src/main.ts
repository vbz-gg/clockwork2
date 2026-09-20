/**
 * The page entry: the only file that knows a browser exists.
 *
 * It wires four things together and owns none of them - a module, a manifest,
 * a presentation and a container. The loop, the input capture and the
 * recording all come from the host bridge, and the simulation knows about
 * none of it.
 */

import { GameHost, InputCapture } from "@clockwork2/host-bridge"
import { encodeRecording } from "@clockwork2/kernel"
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

new InputCapture({ manifest: MANIFEST, queue: host.live as never }).attach()
host.start()
