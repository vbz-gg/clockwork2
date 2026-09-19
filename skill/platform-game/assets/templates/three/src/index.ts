/**
 * The bundle's entry. Two exports and nothing else:
 *
 *   - a default export the platform calls to get a fresh module per session
 *   - `MANIFEST`, which the platform reads without running anything
 *
 * `validate` is pointed at this file. It must not import the renderer: the
 * import graph is scanned transitively, and a simulation that can reach a
 * canvas is a simulation that can decide a score from one.
 */

export { MANIFEST } from "./manifest"
export { type Config, DEFAULT_CONFIG, LaneRunner, type View } from "./sim"

import { LaneRunner } from "./sim"

export default function createGame(): LaneRunner {
  return new LaneRunner()
}
