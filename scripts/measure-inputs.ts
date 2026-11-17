#!/usr/bin/env bun
/**
 * Measures how big an honest recording gets when a game records its inputs
 * with the device helpers.
 *
 * Each scenario is five minutes of virtual time: a real `GameHost` at 60
 * ticks a second, driven by a `ManualScheduler` one animation frame per tick,
 * with the real `InputCapture` attached to its live queue through a fake
 * browser like the one the helpers' unit tests use. A model player sends the
 * device events a browser would deliver between two frames, then the frame
 * runs. What comes out is the recording a page would submit.
 *
 * Every scenario runs twice or more: with the ranges a sensible game would
 * declare, and with a deliberately fine range, because the declared range is
 * also the recording's resolution. Randomness comes from a seeded `Prng`, so
 * the table is the same on every run.
 *
 * It imports the engine from its source rather than from `dist`, which bun
 * would otherwise resolve to and which can be older than the helpers being
 * measured.
 *
 *   bun run scripts/measure-inputs.ts [--out table.md]
 *
 * With `--out` the table is rewritten after each scenario, so a long run
 * leaves what it has measured so far.
 */

import { writeFileSync } from "node:fs"
import { gzipSync } from "node:zlib"
import type {
  Counters,
  Effect,
  GameModule,
  InputEvent,
  Snapshot,
} from "../packages/engine/src/contract"
import {
  type CaptureEnvironment,
  type CaptureMapping,
  GameHost,
  InputCapture,
  ManualScheduler,
} from "../packages/engine/src/host/index"
import {
  checkInputs,
  encodeRecording,
  INPUT_BUDGET_PER_TICK,
  type Inputs,
  type Manifest,
  Prng,
} from "../packages/engine/src/index"

export const TICK_HZ = 60
/** Five minutes of play. */
export const SESSION_TICKS = 5 * 60 * TICK_HZ
/** The window the peak rate is taken over: two seconds. */
export const PEAK_WINDOW = 120
const FRAME_MS = 1000 / TICK_HZ

/** The playfield a touch scenario plays on: a phone held sideways, in CSS pixels. */
export const PHONE = { width: 844, height: 390 } as const
/** The playfield the mouse scenarios play on. */
export const DESKTOP = { width: 1280, height: 720 } as const

/** A target the model player drives by hand, so no DOM is needed. */
class FakeTarget implements EventTarget {
  private readonly listeners = new Map<
    string,
    Set<EventListenerOrEventListenerObject>
  >()

  addEventListener(
    type: string,
    listener: EventListenerOrEventListenerObject | null,
  ): void {
    if (listener === null) return
    const set = this.listeners.get(type) ?? new Set()
    set.add(listener)
    this.listeners.set(type, set)
  }

  removeEventListener(
    type: string,
    listener: EventListenerOrEventListenerObject | null,
  ): void {
    if (listener !== null) this.listeners.get(type)?.delete(listener)
  }

  dispatchEvent(): boolean {
    return true
  }

  /** Delivers an event carrying `fields`, as a browser's trusted one. */
  send(type: string, fields: Readonly<Record<string, unknown>> = {}): void {
    const event = {
      type,
      isTrusted: true,
      preventDefault: () => undefined,
      ...fields,
    } as unknown as Event
    for (const listener of this.listeners.get(type) ?? []) {
      if (typeof listener === "function") listener(event)
      else listener.handleEvent(event)
    }
  }
}

/** What a model player can touch. */
export interface Devices {
  /** Keys and tilt arrive here. */
  readonly window: FakeTarget
  /** Pointers and the wheel arrive here. */
  readonly element: FakeTarget
  /** What `navigator.getGamepads` answers from now on. */
  plug(pad: Gamepad | null): void
}

/** One way of mapping a scenario's devices onto a game's inputs. */
export interface Variant {
  /** How the ranges were chosen, for the table. */
  readonly label: string
  readonly inputs: Inputs
  readonly mapping: CaptureMapping
}

/** Sends the events a browser delivers before frame `frame` runs. */
export type Driver = (frame: number, devices: Devices, random: Prng) => void

export interface Scenario {
  readonly name: string
  /** What the model player does, in a sentence the table carries. */
  readonly does: string
  readonly playfield: { readonly width: number; readonly height: number }
  /** The mouse is locked to the game for the whole run. */
  readonly locked?: boolean
  readonly variants: readonly Variant[]
  /** A fresh player for one run, holding whatever it needs to remember. */
  play(): Driver
}

export interface Row {
  readonly scenario: string
  readonly variant: string
  readonly ticks: number
  readonly frames: number
  readonly inputs: number
  readonly perTick: number
  readonly peakPerTick: number
  readonly bytes: number
  readonly gzipBytes: number
  /** The log alone as JSON, over its inputs: what one more input costs. */
  readonly bytesPerInput: number
  /** Whether `checkInputs` accepts the log at the current budget. */
  readonly withinBudget: boolean
}

/**
 * The most inputs any `window` consecutive ticks hold, over `window`.
 *
 * The window slides one tick at a time. Fixed windows would split a burst
 * across two of them and report half of it.
 */
export function peakPerTick(
  log: readonly InputEvent[],
  ticks: number,
  window: number = PEAK_WINDOW,
): number {
  if (!Number.isInteger(window) || window < 1) {
    throw new Error(`a window is a whole number of ticks, got ${window}`)
  }
  const counts = new Array<number>(Math.max(ticks, window)).fill(0)
  for (const event of log) {
    if (event.tick >= counts.length) {
      throw new Error(`an input at tick ${event.tick} is past ${ticks} ticks`)
    }
    counts[event.tick] = (counts[event.tick] as number) + 1
  }
  let inWindow = 0
  let most = 0
  for (let tick = 0; tick < counts.length; tick++) {
    inWindow += counts[tick] as number
    if (tick >= window) inWindow -= counts[tick - window] as number
    most = Math.max(most, inWindow)
  }
  return most / window
}

/** A game that records nothing of its own, and counts what it is handed. */
class CountingGame implements GameModule {
  constructor(readonly manifest: Manifest) {}
  private ticks = 0
  private seen = 0

  init(): void {
    this.ticks = 0
    this.seen = 0
  }

  tick(inputs: readonly InputEvent[]): void {
    this.seen += inputs.length
    this.ticks++
  }

  view(): unknown {
    return null
  }

  snapshot(): Snapshot {
    return { ticks: this.ticks, seen: this.seen }
  }

  restore(snapshot: Snapshot): void {
    this.ticks = snapshot.ticks as number
    this.seen = snapshot.seen as number
  }

  score(): Counters {
    return { inputs: this.seen, ticksSurvived: this.ticks }
  }

  isOver(): boolean {
    return false
  }

  effects(): readonly Effect[] {
    return []
  }
}

function manifestFor(scenario: Scenario, variant: Variant): Manifest {
  return {
    schemaVersion: 3,
    id: `measure-${scenario.name.toLowerCase().replace(/[^a-z0-9]+/g, "-")}`,
    version: "1.0.0",
    name: scenario.name,
    kernel: { version: "0.1.0" },
    session: { tickHz: TICK_HZ, hasEnding: false },
    inputs: variant.inputs,
    counters: [
      { name: "inputs", direction: "up", monotonic: true },
      { name: "ticksSurvived", direction: "up", monotonic: true },
    ],
    rankBy: ["inputs"],
    tiePolicy: "shared",
    capabilities: {
      deterministic: true,
      physics: "none",
      renderer: "canvas2d",
      multiplayer: false,
      pointerLock: scenario.locked === true,
    },
  }
}

/** Plays one variant of a scenario for `ticks` ticks and measures what it recorded. */
export function measure(
  scenario: Scenario,
  variant: Variant,
  ticks: number = SESSION_TICKS,
): { readonly row: Row; readonly log: readonly InputEvent[] } {
  const manifest = manifestFor(scenario, variant)
  const scheduler = new ManualScheduler()
  let failure: unknown = null
  const host = new GameHost({
    module: new CountingGame(manifest),
    manifest,
    seed: "measure",
    scheduler,
    maxTicks: ticks,
    onError: (error) => {
      failure = error
    },
  })
  const queue = host.live
  if (queue === null) throw new Error("a live session has a live queue")

  const window = new FakeTarget()
  const element = new FakeTarget()
  const document = Object.assign(new FakeTarget(), {
    visibilityState: "visible",
    pointerLockElement: null as unknown,
  })
  const html = Object.assign(element, {
    getBoundingClientRect: () => ({
      left: 0,
      top: 0,
      ...scenario.playfield,
    }),
    style: { touchAction: "" },
    setPointerCapture: () => undefined,
    requestPointerLock: () => undefined,
  })
  if (scenario.locked === true) document.pointerLockElement = html
  let pad: Gamepad | null = null
  const environment: CaptureEnvironment = {
    window,
    document: document as unknown as CaptureEnvironment["document"],
    gamepads: () => [pad, null, null, null],
    screenAngle: () => 0,
  }
  const capture = new InputCapture({
    manifest,
    queue,
    // The model player's events are made by this script, so they are recorded
    // as a browser records a person's.
    scripted: "record",
    element: html as unknown as HTMLElement,
    ...variant.mapping,
    onNotice: (notice) => {
      throw new Error(`${scenario.name}: ${notice.code} ${notice.detail}`)
    },
    environment,
  })
  capture.attach()

  const devices: Devices = {
    window,
    element,
    plug: (next) => {
      pad = next
    },
  }
  // One stream per scenario, so adding a variant moves no other number.
  const random = new Prng(`measure ${scenario.name}`)
  const drive = scenario.play()
  let frame = 0
  host.start()
  while (host.status === "running") {
    drive(frame, devices, random)
    scheduler.advance(FRAME_MS)
    frame++
  }
  capture.detach()
  if (failure !== null) {
    throw new Error(`${scenario.name}, ${variant.label}: the run failed`, {
      cause: failure,
    })
  }

  const recording = host.recording()
  if (recording.endTick !== ticks) {
    throw new Error(
      `${scenario.name}, ${variant.label}: ended at tick ${recording.endTick}, not ${ticks}`,
    )
  }
  const log = recording.inputs
  const encoded = encodeRecording(recording)
  let withinBudget = true
  try {
    checkInputs(log, manifest.inputs, { endTick: recording.endTick })
  } catch {
    withinBudget = false
  }
  return {
    log,
    row: {
      scenario: scenario.name,
      variant: variant.label,
      ticks: recording.endTick,
      frames: frame,
      inputs: log.length,
      perTick: log.length / recording.endTick,
      peakPerTick: peakPerTick(log, recording.endTick),
      bytes: Buffer.byteLength(encoded),
      gzipBytes: gzipSync(encoded).length,
      bytesPerInput:
        log.length === 0
          ? 0
          : Buffer.byteLength(JSON.stringify(log)) / log.length,
      withinBudget,
    },
  }
}

const PRESS = { min: 0, max: 1 } as const
const seconds = (frame: number): number => frame / TICK_HZ
const TURN = 2 * Math.PI

/** A pad with nothing pressed and its sticks where `axes` say. */
function padAt(axes: readonly number[]): Gamepad {
  return {
    index: 0,
    id: "model pad",
    mapping: "standard",
    connected: true,
    timestamp: 0,
    buttons: Array.from({ length: 17 }, () => ({
      pressed: false,
      touched: false,
      value: 0,
    })),
    axes,
  } as unknown as Gamepad
}

/** A normally distributed number, by Box-Muller over the seeded stream. */
function gaussian(random: Prng, sigma: number): number {
  const u = 1 - random.random()
  const v = random.random()
  return sigma * Math.sqrt(-2 * Math.log(u)) * Math.cos(TURN * v)
}

const thumbInputs = (x: number, y: number): Inputs => ({
  left: PRESS,
  leftX: { min: 0, max: x },
  leftY: { min: 0, max: y },
  right: PRESS,
  rightX: { min: 0, max: x },
  rightY: { min: 0, max: y },
})

const THUMBS: CaptureMapping = {
  pointers: [
    { down: "left", x: "leftX", y: "leftY" },
    { down: "right", x: "rightX", y: "rightY" },
  ],
}

/** Each thumb's circle: centre, radius and seconds per turn. */
const THUMB_PATHS = [
  { id: 11, cx: 210, cy: 250, r: 80, period: 0.75 },
  { id: 12, cx: 640, cy: 250, r: 80, period: 1 },
] as const

/** Four keys, each mashed on its own. */
const MASHED = ["ArrowLeft", "ArrowRight", "Space", "KeyX"] as const

export const SCENARIOS: readonly Scenario[] = [
  {
    name: "Two thumbs",
    does: "two fingers go down at once and never lift; each traces a circle of 80 px radius, one every 0.75 s (670 px/s) and one every 1 s (503 px/s), one pointermove per finger per frame",
    playfield: PHONE,
    variants: [
      {
        label: "x 0 to 63, y 0 to 29 (about 13 px a step)",
        inputs: thumbInputs(63, 29),
        mapping: THUMBS,
      },
      {
        label: "fine: x and y 0 to 1000",
        inputs: thumbInputs(1000, 1000),
        mapping: THUMBS,
      },
    ],
    play: () => (frame, devices) => {
      for (const path of THUMB_PATHS) {
        const angle = (TURN * seconds(frame)) / path.period
        devices.element.send(frame === 0 ? "pointerdown" : "pointermove", {
          pointerId: path.id,
          pointerType: "touch",
          buttons: 1,
          clientX: path.cx + path.r * Math.cos(angle),
          clientY: path.cy + path.r * Math.sin(angle),
        })
      }
    },
  },
  {
    name: "Stick swept",
    does: "the left stick's x follows sin(2 pi t / 1 s) at full deflection and its y 0.6 sin(2 pi t / 1.7 s), read once a frame",
    playfield: DESKTOP,
    variants: [
      {
        label: "each axis -100 to 100",
        inputs: {
          stickX: { min: -100, max: 100 },
          stickY: { min: -100, max: 100 },
        },
        mapping: { gamepads: { any: { axes: { 0: "stickX", 1: "stickY" } } } },
      },
      {
        label: "fine: each axis -1000 to 1000",
        inputs: {
          stickX: { min: -1000, max: 1000 },
          stickY: { min: -1000, max: 1000 },
        },
        mapping: { gamepads: { any: { axes: { 0: "stickX", 1: "stickY" } } } },
      },
    ],
    play: () => (frame, devices) => {
      const t = seconds(frame)
      devices.plug(
        padAt([Math.sin(TURN * t), 0.6 * Math.sin((TURN * t) / 1.7), 0, 0]),
      )
    },
  },
  {
    name: "Mouse under lock",
    does: "one pointermove per frame, movementX cycling 2, 3, 4, 5, 6 px (240 px/s across) and movementY round(3 sin(2 pi t / 2 s)) px, sweeping up and down",
    playfield: DESKTOP,
    locked: true,
    variants: [
      {
        label: "4 px a unit, -32 to 32 a tick",
        inputs: { lookX: { min: -32, max: 32 }, lookY: { min: -32, max: 32 } },
        mapping: { mouseLock: { dx: "lookX", dy: "lookY", pixelsPerUnit: 4 } },
      },
      {
        label: "fine: 1 px a unit, -1000 to 1000 a tick",
        inputs: {
          lookX: { min: -1000, max: 1000 },
          lookY: { min: -1000, max: 1000 },
        },
        mapping: { mouseLock: { dx: "lookX", dy: "lookY", pixelsPerUnit: 1 } },
      },
    ],
    play: () => (frame, devices) => {
      devices.element.send("pointermove", {
        pointerId: 1,
        pointerType: "mouse",
        buttons: 0,
        clientX: 640,
        clientY: 360,
        movementX: 2 + (frame % 5),
        movementY: Math.round(3 * Math.sin((TURN * seconds(frame)) / 2)),
      })
    },
  },
  {
    name: "Wheel in bursts",
    does: "every 3 s, 12 notches of 100 px one every 2 frames (30 notches/s), the direction alternating between bursts",
    playfield: DESKTOP,
    variants: [
      {
        label: "1 notch a unit, -10 to 10 a tick",
        inputs: { zoom: { min: -10, max: 10 } },
        mapping: { wheel: { y: "zoom" } },
      },
      {
        label: "fine: 1 px a unit, -1000 to 1000 a tick",
        inputs: { zoom: { min: -1000, max: 1000 } },
        mapping: { wheel: { y: "zoom", notchesPerUnit: 0.01 } },
      },
    ],
    play: () => (frame, devices) => {
      const into = frame % 180
      if (into >= 24 || into % 2 !== 0) return
      const burst = Math.floor(frame / 180)
      devices.element.send("wheel", {
        deltaMode: 0,
        deltaX: 0,
        deltaY: burst % 2 === 0 ? 100 : -100,
      })
    },
  },
  {
    name: "Trackpad flings",
    does: "every 3 s, a one-second fling: one wheel event a frame whose deltaY falls from 40 px to 1 px, the direction alternating between flings",
    playfield: DESKTOP,
    variants: [
      {
        label: "1 notch (100 px) a unit, -10 to 10 a tick",
        inputs: { zoom: { min: -10, max: 10 } },
        mapping: { wheel: { y: "zoom" } },
      },
      {
        label: "fine: 1 px a unit, -1000 to 1000 a tick",
        inputs: { zoom: { min: -1000, max: 1000 } },
        mapping: { wheel: { y: "zoom", notchesPerUnit: 0.01 } },
      },
    ],
    play: () => (frame, devices) => {
      const into = frame % 180
      if (into >= 60) return
      const burst = Math.floor(frame / 180)
      const delta = Math.max(1, Math.round(40 * (1 - into / 60)))
      devices.element.send("wheel", {
        deltaMode: 0,
        deltaX: 0,
        deltaY: burst % 2 === 0 ? delta : -delta,
      })
    },
  },
  {
    name: "Tilt in the hand",
    does: "60 readings a second: beta 35 + 12 sin(2 pi t / 5 s) and gamma 15 sin(2 pi t / 3.7 s) degrees, each reading plus normal noise of 0.25 degrees standard deviation",
    playfield: PHONE,
    variants: [
      {
        label: "x and y -100 to 100, full at 45 degrees",
        inputs: {
          tiltX: { min: -100, max: 100 },
          tiltY: { min: -100, max: 100 },
        },
        mapping: { tilt: { x: "tiltX", y: "tiltY", fullAt: 45 } },
      },
      {
        label: "fine: x and y -1000 to 1000, full at 45 degrees",
        inputs: {
          tiltX: { min: -1000, max: 1000 },
          tiltY: { min: -1000, max: 1000 },
        },
        mapping: { tilt: { x: "tiltX", y: "tiltY", fullAt: 45 } },
      },
    ],
    play: () => (frame, devices, random) => {
      const t = seconds(frame)
      devices.window.send("deviceorientation", {
        alpha: 0,
        beta: 35 + 12 * Math.sin((TURN * t) / 5) + gaussian(random, 0.25),
        gamma: 15 * Math.sin((TURN * t) / 3.7) + gaussian(random, 0.25),
      })
    },
  },
  {
    name: "Keys mashed",
    does: "four keys mashed at once, each held 3 to 5 frames and let go 2 to 5 frames, drawn at random: about 8 presses a second a key, 32 in all",
    playfield: DESKTOP,
    variants: [
      {
        label: "four presses, 0 to 1 (a press has no finer range)",
        inputs: { left: PRESS, right: PRESS, jump: PRESS, fire: PRESS },
        mapping: {
          keys: {
            ArrowLeft: "left",
            ArrowRight: "right",
            Space: "jump",
            KeyX: "fire",
          },
        },
      },
    ],
    play: () => {
      // Each key starts a frame after the one before, then keeps its own
      // time: down or up, and the frame it next changes.
      const keys = MASHED.map((code, k) => ({ code, down: false, next: k }))
      return (frame, devices, random) => {
        for (const key of keys) {
          if (frame < key.next) continue
          key.down = !key.down
          devices.window.send(key.down ? "keydown" : "keyup", {
            code: key.code,
            repeat: false,
            target: null,
          })
          key.next =
            frame + (key.down ? random.randomInt(3, 5) : random.randomInt(2, 5))
        }
      }
    },
  },
]

/** The baseline: five minutes in which nothing is pressed. */
export const IDLE: Scenario = {
  name: "Nothing pressed",
  does: "no events at all, so this is what a recording costs before inputs",
  playfield: DESKTOP,
  variants: [
    {
      label: "one press declared",
      inputs: { jump: PRESS },
      mapping: { keys: { Space: "jump" } },
    },
  ],
  play: () => () => undefined,
}

const fixed = (value: number, digits: number): string => value.toFixed(digits)

export function table(rows: readonly Row[]): string {
  const lines = [
    "| Scenario | Declared | Inputs | Per tick | Peak per tick (120-tick window) | Recording bytes | Gzipped | Log bytes per input | Within budget of " +
      `${INPUT_BUDGET_PER_TICK} |`,
    "|---|---|---:|---:|---:|---:|---:|---:|---|",
  ]
  for (const row of rows) {
    lines.push(
      `| ${row.scenario} | ${row.variant} | ${row.inputs} | ${fixed(row.perTick, 3)} | ${fixed(row.peakPerTick, 3)} | ${row.bytes} | ${row.gzipBytes} | ${fixed(row.bytesPerInput, 1)} | ${row.withinBudget ? "yes" : "no"} |`,
    )
  }
  return lines.join("\n")
}

function report(rows: readonly Row[], scenarios: readonly Scenario[]): string {
  const ticks = rows[0]?.ticks ?? SESSION_TICKS
  const frames = rows[0]?.frames ?? 0
  return [
    "# Recording sizes from the device helpers",
    "",
    `Produced in the clockwork2 repository by \`bun run scripts/measure-inputs.ts\`. Each row is one run of ${ticks} ticks (five minutes at ${TICK_HZ} Hz) in a real \`GameHost\` driven by a \`ManualScheduler\`, one animation frame of 1000/60 ms per tick (${frames} frames for the first row), under bun ${Bun.version}, importing the engine from \`packages/engine/src\`. The real \`InputCapture\` is attached to the host's live queue through a fake browser; before each frame the model player below sends the events a browser would deliver, then the frame runs and the queue stamps what is pending onto the frame's tick.`,
    "",
    "- **Inputs** is the length of `recording.inputs` at the end.",
    "- **Per tick** is inputs over the run's end tick.",
    `- **Peak per tick** is the most inputs in any ${PEAK_WINDOW} consecutive ticks, the window sliding one tick at a time, over ${PEAK_WINDOW}.`,
    "- **Recording bytes** is the UTF-8 length of `encodeRecording(host.recording())`: the inputs, a checkpoint every 60 ticks, the counters and the rest of the envelope. The baseline row is the same run with nothing pressed.",
    "- **Gzipped** is that text through node's `gzipSync` at its default level.",
    "- **Log bytes per input** is the UTF-8 length of `JSON.stringify(recording.inputs)` over its inputs. An input's name is in every one of them, so a shorter name is a smaller recording.",
    `- **Within budget** is whether \`checkInputs\` accepts the log against its manifest at the current \`INPUT_BUDGET_PER_TICK\` of ${INPUT_BUDGET_PER_TICK}.`,
    "- Randomness (key timings, tilt noise) comes from a `Prng` seeded with the scenario's name, so a rerun gives the same table.",
    "",
    table(rows),
    "",
    "## What each model player does",
    "",
    ...scenarios.map(
      (s) =>
        `- **${s.name}**, on a ${s.playfield.width} by ${s.playfield.height} CSS px element: ${s.does}.`,
    ),
    "",
  ].join("\n")
}

function main(argv: readonly string[]): number {
  const at = argv.indexOf("--out")
  const out = at === -1 ? undefined : argv[at + 1]
  if (at !== -1 && out === undefined) {
    console.error("usage: measure-inputs [--out table.md]")
    return 2
  }
  const scenarios = [IDLE, ...SCENARIOS]
  const rows: Row[] = []
  for (const scenario of scenarios) {
    for (const variant of scenario.variants) {
      rows.push(measure(scenario, variant).row)
      if (out !== undefined) writeFileSync(out, report(rows, scenarios))
    }
  }
  console.log(report(rows, scenarios))
  return 0
}

if (import.meta.main) process.exit(main(process.argv.slice(2)))
