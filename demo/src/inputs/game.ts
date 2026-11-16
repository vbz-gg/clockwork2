/**
 * A game with an input for every device helper, which does nothing with them
 * but count.
 *
 * The page it runs in is the subject, not the game: the end-to-end suite
 * drives real keys, a real mouse, the wheel, a stubbed controller and an
 * overridden orientation sensor at that page and reads back what the helpers
 * recorded. So the simulation is the smallest that still runs a session: it
 * counts the inputs it is handed and keeps the last value of each.
 *
 * The ranges are a sensible game's, coarse where coarse is enough, because
 * the declared range is also the recording's resolution: a pointer across
 * this 640 by 360 playfield in 64 by 36 steps records one input per 10 CSS
 * pixels it moves, and in 0 to 1000 it would record ten times as many.
 */

import type {
  Counters,
  Effect,
  GameModule,
  InputDeclaration,
  InputEvent,
  Manifest,
  Snapshot,
} from "@clockwork2/engine"

const PRESS: InputDeclaration = { min: 0, max: 1 }
/** Across the playfield, one step per 10 CSS pixels of the 640 by 360 stage. */
const ACROSS: InputDeclaration = { min: 0, max: 63 }
const DOWN: InputDeclaration = { min: 0, max: 35 }
/** A stick or a tilt axis, centred at 0. */
const SIGNED: InputDeclaration = { min: -100, max: 100 }

export const TICK_HZ = 60

export const MANIFEST: Manifest = {
  schemaVersion: 2,
  id: "clockwork2-inputs",
  version: "1.0.0",
  name: "Every input helper",
  kernel: { version: "0.1.0" },
  session: {
    tickHz: TICK_HZ,
    // Ten minutes, long past any spec. The game never ends by itself.
    maxTicks: TICK_HZ * 60 * 10,
    maxWallSeconds: 900,
    hasEnding: false,
  },
  inputs: {
    left: { ...PRESS, label: "Left" },
    right: { ...PRESS, label: "Right" },
    jump: { ...PRESS, label: "Jump" },
    touch: { ...PRESS, label: "Touch" },
    touchX: ACROSS,
    touchY: DOWN,
    alt: { ...PRESS, label: "Right button" },
    touch2: { ...PRESS, label: "Second finger" },
    touch2X: ACROSS,
    touch2Y: DOWN,
    hoverX: ACROSS,
    hoverY: DOWN,
    lookX: { min: -100, max: 100, label: "Look across" },
    lookY: { min: -100, max: 100, label: "Look up and down" },
    zoom: { min: -10, max: 10, label: "Zoom" },
    padA: { ...PRESS, label: "Controller A" },
    padTrigger: { min: 0, max: 10, label: "Right trigger" },
    padX: SIGNED,
    padY: SIGNED,
    tiltX: SIGNED,
    tiltY: SIGNED,
    tiltZ: SIGNED,
  },
  counters: [
    { name: "inputs", direction: "up", monotonic: true, label: "Inputs" },
    { name: "ticksSurvived", direction: "up", monotonic: true, label: "Ticks" },
  ],
  rankBy: ["inputs"],
  tiePolicy: "shared",
  capabilities: {
    deterministic: true,
    physics: "none",
    renderer: "dom",
    multiplayer: false,
    pointerLock: true,
  },
}

export type InputsView = { readonly ticks: number; readonly inputs: number }

export class InputsGame implements GameModule<InputsView> {
  readonly manifest = MANIFEST
  private ticks = 0
  private inputs = 0
  private last: { [code: string]: number } = {}

  init(): void {
    this.ticks = 0
    this.inputs = 0
    this.last = {}
  }

  tick(inputs: readonly InputEvent[]): void {
    for (const input of inputs) {
      this.inputs++
      this.last[input.code] = input.value
    }
    this.ticks++
  }

  view(): InputsView {
    return { ticks: this.ticks, inputs: this.inputs }
  }

  snapshot(): Snapshot {
    return { ticks: this.ticks, inputs: this.inputs, last: { ...this.last } }
  }

  restore(snapshot: Snapshot): void {
    const s = snapshot as unknown as {
      ticks: number
      inputs: number
      last: { [code: string]: number }
    }
    this.ticks = s.ticks
    this.inputs = s.inputs
    this.last = { ...s.last }
  }

  score(): Counters {
    return { inputs: this.inputs, ticksSurvived: this.ticks }
  }

  isOver(): boolean {
    return false
  }

  effects(): readonly Effect[] {
    return []
  }
}

export function createGame(): InputsGame {
  return new InputsGame()
}
