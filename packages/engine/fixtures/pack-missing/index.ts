/**
 * Deliberately non-conformant: the start pack is declared and never shipped.
 * No session can start without it, so every check that runs the game reports
 * that it was not delivered, and the budgets check that it is not present.
 */

import { packGame, packManifest, RULES } from "../pack-game"

export const MANIFEST = packManifest("pack-missing", [RULES])

export default packGame(MANIFEST)
