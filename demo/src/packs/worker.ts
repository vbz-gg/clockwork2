/** The pack game's simulation, in a worker of its own. */

import { runSimulationWorker } from "@clockwork2/engine/worker"
import createGame, {
  MANIFEST,
} from "../../../packages/engine/fixtures/packs/index"

runSimulationWorker(createGame, MANIFEST)
