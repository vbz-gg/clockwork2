/**
 * Deliberately non-conformant for a ranked run: the conforming game with a
 * manifest that says nothing about how a run ranks. A game played only on its
 * own page needs no `rankBy` or `tiePolicy`, so every check a game needs
 * passes; the ranking check refuses it.
 */
import type { Manifest } from "@clockwork2/engine"
import { ConformingGame, MANIFEST as RANKED } from "../conforming/index"

const { rankBy: _rankBy, tiePolicy: _tiePolicy, ...unranked } = RANKED

export const MANIFEST: Manifest = { ...unranked, id: "unranked-fixture" }

export class UnrankedGame extends ConformingGame {
  override readonly manifest = MANIFEST
}

export default function createGame(): UnrankedGame {
  return new UnrankedGame()
}
