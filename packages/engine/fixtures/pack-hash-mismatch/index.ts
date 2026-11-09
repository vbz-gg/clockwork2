/**
 * Deliberately non-conformant: the start pack ships at its declared size with
 * a different fingerprint. The kernel checks every pack before a session may
 * read it, so no session starts.
 */

import { packGame, packManifest, RULES } from "../pack-game"

export const MANIFEST = packManifest("pack-hash-mismatch", [
  { ...RULES, sha256: "0".repeat(64) },
])

export default packGame(MANIFEST)
