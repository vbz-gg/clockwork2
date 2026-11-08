/**
 * Deliberately non-conformant: the start pack is longer than its declaration.
 * The kernel refuses it on its size, before it reads a byte of it for the
 * fingerprint.
 */

import { packGame, packManifest, RULES } from "../pack-game"

export const MANIFEST = packManifest("pack-too-large", [
  { ...RULES, bytes: 20 },
])

export default packGame(MANIFEST)
