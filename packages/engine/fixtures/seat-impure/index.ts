/**
 * Deliberately non-conformant: `seat()` counts how often it is asked, in
 * state the snapshot carries. Every host asks once per tick, so two runs
 * agree, and the determinism check's extra call is what shows the count
 * moving: `E_DETERMINISM_DIVERGED`, naming seat().
 */
import type { Snapshot } from "@clockwork2/engine"
import { TurnsGame } from "../seats/index"

export class SeatImpureGame extends TurnsGame {
  private asked = 0

  override init(seed: string): void {
    super.init(seed)
    this.asked = 0
  }

  override seat(): number {
    this.asked++
    return super.seat()
  }

  override snapshot(): Snapshot {
    return { ...super.snapshot(), asked: this.asked }
  }

  override restore(snapshot: Snapshot): void {
    super.restore(snapshot)
    this.asked = snapshot.asked as number
  }
}

export default function createGame(): SeatImpureGame {
  return new SeatImpureGame()
}
