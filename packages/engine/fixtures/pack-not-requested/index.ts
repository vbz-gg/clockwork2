/**
 * Deliberately non-conformant: the game reads its demand pack without naming
 * it in packsNeeded() first. Whether the bytes happened to be there would
 * then depend on how fast the host downloaded them, so the kernel refuses the
 * read in every host, whether or not they were.
 */

import { LEVEL, packGame, packManifest, RULES } from "../pack-game"

export const MANIFEST = packManifest("pack-not-requested", [RULES, LEVEL])

export default packGame(MANIFEST, (packs, tick) => {
  if (tick === 10) packs.open(LEVEL.path)
})
