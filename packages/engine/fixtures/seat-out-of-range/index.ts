/**
 * Deliberately non-conformant: once the first turn passes, `seat()` answers
 * 2 in a run of two seats, 0 and 1, and the kernel stops the run there with
 * `E_SEAT_INVALID`.
 */
import { TurnsGame } from "../seats/index"

export class SeatOutOfRangeGame extends TurnsGame {
  override seat(): number {
    return this.turn === 0 ? 0 : 2
  }
}

export default function createGame(): SeatOutOfRangeGame {
  return new SeatOutOfRangeGame()
}
