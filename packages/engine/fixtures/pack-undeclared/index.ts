/**
 * Deliberately non-conformant: the game reads a pack its manifest never
 * declared. A pack the manifest does not name is not covered by the manifest
 * hash, so a recording could not pin it, and the kernel refuses the read.
 */

import { packGame, packManifest, RULES } from "../pack-game"

export const MANIFEST = packManifest("pack-undeclared", [RULES])

export default packGame(MANIFEST, (packs, tick) => {
  if (tick === 10) packs.open("data/secret.json")
})
