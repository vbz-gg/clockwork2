/**
 * Deliberately non-conformant: the manifest declares two seats and the game
 * has no `seat()`, so nothing says whose turn a tick is. The session refuses
 * to be built, with `E_SEAT_INVALID`.
 */
import { TurnsWithoutSeat } from "../seats/index"

export default function createGame(): TurnsWithoutSeat {
  return new TurnsWithoutSeat()
}
