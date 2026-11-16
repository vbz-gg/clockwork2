/**
 * Optional device helpers: turning keys, pointers, the mouse, the wheel,
 * gamepads and tilt into a game's own inputs.
 *
 * A game declares its inputs in its manifest, by name and range, and decides
 * what to record. These helpers are one way to do it, for the common devices,
 * and a game may use them, use part of them, or record its inputs itself.
 * The mapping from a device to an input name lives in the game's code, not
 * the manifest: the manifest says what is recorded, the game says from what.
 *
 * Two things they do that a game would otherwise have to remember.
 *
 * They record changes, not a stream. A level (a position, a stick, tilt) is
 * recorded only when its value in the declared range changes, merged to one
 * value per tick, with a deadband for sticks and tilt. An amount (the wheel,
 * mouse movement) is summed per tick, its fraction carried. So the declared
 * range is also the recording's resolution: a coarser range records less.
 *
 * And every press they record they also release. A finger that slides off
 * the game, a mouse released over another part of the page, a tab put in the
 * background, a controller unplugged, a pause: each ends the press in the
 * log. A press that never ends is a game that runs into a wall for the rest
 * of the session.
 */

import { fail } from "../errors.js"
import {
  type InputDeclaration,
  type InputSink,
  KEY_CODES,
  type Manifest,
  type MergeRule,
  quantiseAxis,
} from "../index.js"
import { noteReading } from "./motion.js"

/** Fingers, pens and the mouse, each with a small slot number. */
export const POINTER_SLOTS = 10
/** `PointerEvent.button` values: main, middle, right, back, forward. */
export const POINTER_BUTTONS = 5
/** The four controllers a browser reports at most. */
export const GAMEPAD_SLOTS = 4
export const GAMEPAD_BUTTONS = 32
export const GAMEPAD_AXES = 16

/** One finger's or the mouse's inputs, by slot. */
export interface PointerSlot {
  /** A press: the pointer is down. */
  readonly down?: string
  /** Levels: where it is while down, across the element, in each name's range. */
  readonly x?: string
  readonly y?: string
  /** Presses, by `PointerEvent.button`: 1 middle, 2 right, 3 back, 4 forward. */
  readonly buttons?: { readonly [button: string]: string }
}

export interface GamepadMapping {
  /** Presses, by button index. */
  readonly buttons?: { readonly [button: string]: string }
  /** Levels: how far an analog button, such as a trigger, is pressed. */
  readonly values?: { readonly [button: string]: string }
  /** Levels: a stick axis, centred at the middle of its range. */
  readonly axes?: { readonly [axis: string]: string }
}

/** Which device drives which of the game's inputs. Every part is optional. */
export interface CaptureMapping {
  /** Presses, by `KeyboardEvent.code`. */
  readonly keys?: { readonly [code: string]: string }
  /** Slot 0 is the first finger down, slot 1 the second, and so on. */
  readonly pointers?: readonly PointerSlot[]
  /** Levels: a mouse or pen moving with nothing pressed. */
  readonly hover?: { readonly x?: string; readonly y?: string }
  /** Amounts: mouse movement while it is locked to the game. */
  readonly mouseLock?: {
    readonly dx?: string
    readonly dy?: string
    /** CSS pixels per unit recorded. 1 by default. */
    readonly pixelsPerUnit?: number
  }
  /** Amounts: wheel notches. */
  readonly wheel?: {
    readonly x?: string
    readonly y?: string
    /** Notches per unit recorded. 1 by default. */
    readonly notchesPerUnit?: number
  }
  /** By `Gamepad.index`, "0" to "3", or "any" for whichever is connected first. */
  readonly gamepads?: { readonly [slot: string]: GamepadMapping }
  /**
   * Levels: which way gravity points across the screen, x to the right, y
   * up, z out of the screen, each mapped onto its name's range. Ask for it
   * with `requestMotion` first.
   */
  readonly tilt?: {
    readonly x?: string
    readonly y?: string
    readonly z?: string
    /** The tilt in degrees that reads as the end of the range. 90 by default. */
    readonly fullAt?: number
  }
}

/**
 * Something about a device the page should tell the player, which does not
 * stop the run: a player on keys or touch plays on whatever a controller
 * does.
 */
export const DEVICE_NOTICES = {
  /** The page forbids gamepads, so none is read. */
  GAMEPAD_BLOCKED: "E_GAMEPAD_BLOCKED",
  /** A controller reports no standard layout, so its buttons may sit elsewhere. */
  GAMEPAD_UNMAPPED: "E_GAMEPAD_UNMAPPED",
  /** The browser refused to lock the mouse to the game. */
  POINTER_LOCK_REFUSED: "E_POINTER_LOCK_REFUSED",
} as const

export type DeviceNoticeCode =
  (typeof DEVICE_NOTICES)[keyof typeof DEVICE_NOTICES]

export interface DeviceNotice {
  readonly code: DeviceNoticeCode
  readonly detail: string
}

/** What the helpers need from a document. */
export interface CaptureDocument extends EventTarget {
  readonly visibilityState?: string
  readonly pointerLockElement?: Element | null
}

/** The browser, for a test to stand in for. Read when `attach` runs, never at import. */
export interface CaptureEnvironment {
  /** Hears keys, `blur`, `deviceorientation`, and the pointer backstop. */
  readonly window: EventTarget
  /** Hears `visibilitychange` and `pointerlockchange`. */
  readonly document: CaptureDocument
  /** `navigator.getGamepads`. */
  readonly gamepads: () => readonly (Gamepad | null)[]
  /** How far the screen is turned from the device's natural orientation. */
  readonly screenAngle: () => number | undefined
}

export interface InputCaptureOptions extends CaptureMapping {
  readonly manifest: Manifest
  /** Where inputs go: a session's live queue, or a worker's. */
  readonly queue: InputSink
  /**
   * The element the game is drawn on. A pointer's position is measured
   * across it, on each axis separately, so it must be the element the
   * playfield fills, stretched the same way. The wheel is heard on it.
   * Required when pointers, hover, mouse lock or the wheel are mapped.
   */
  readonly element?: HTMLElement
  /** Required when a gamepad or mouse lock is mapped. */
  readonly onNotice?: (notice: DeviceNotice) => void
  /** For a test. The browser's own by default. */
  readonly environment?: CaptureEnvironment
}

/** How the helpers treat a mapped name. */
type Kind = "press" | "level" | "amount"

type Driven = { readonly kinds: Set<Kind>; readonly sources: string[] }

/** Every name a mapping drives, with its kinds and the sources that drive it. */
function drivenBy(mapping: CaptureMapping): Map<string, Driven> {
  const names = new Map<string, Driven>()
  const add = (name: string | undefined, kind: Kind, source: string): void => {
    if (name === undefined) return
    const entry = names.get(name) ?? { kinds: new Set<Kind>(), sources: [] }
    entry.kinds.add(kind)
    entry.sources.push(source)
    names.set(name, entry)
  }
  for (const [code, name] of Object.entries(mapping.keys ?? {})) {
    add(name, "press", `key ${code}`)
  }
  ;(mapping.pointers ?? []).forEach((slot, s) => {
    add(slot.down, "press", `pointer ${s} down`)
    add(slot.x, "level", `pointer ${s} x`)
    add(slot.y, "level", `pointer ${s} y`)
    for (const [button, name] of Object.entries(slot.buttons ?? {})) {
      add(name, "press", `pointer ${s} button ${button}`)
    }
  })
  add(mapping.hover?.x, "level", "hover x")
  add(mapping.hover?.y, "level", "hover y")
  add(mapping.mouseLock?.dx, "amount", "mouse dx")
  add(mapping.mouseLock?.dy, "amount", "mouse dy")
  add(mapping.wheel?.x, "amount", "wheel x")
  add(mapping.wheel?.y, "amount", "wheel y")
  for (const [slot, pad] of Object.entries(mapping.gamepads ?? {})) {
    for (const [b, name] of Object.entries(pad.buttons ?? {})) {
      add(name, "press", `gamepad ${slot} button ${b}`)
    }
    for (const [b, name] of Object.entries(pad.values ?? {})) {
      add(name, "level", `gamepad ${slot} value ${b}`)
    }
    for (const [a, name] of Object.entries(pad.axes ?? {})) {
      add(name, "level", `gamepad ${slot} axis ${a}`)
    }
  }
  add(mapping.tilt?.x, "level", "tilt x")
  add(mapping.tilt?.y, "level", "tilt y")
  add(mapping.tilt?.z, "level", "tilt z")
  return names
}

const KEYS = new Set(KEY_CODES)

/** A decimal index below `limit`, with no leading zero. */
function indexIn(value: string, limit: number): boolean {
  return /^(0|[1-9][0-9]*)$/.test(value) && Number(value) < limit
}

/**
 * Every problem with `mapping` against `manifest`, or an empty list. Pure, so
 * a page, `vbz check` and `vbz dev` can run it before a run is started: a
 * mapping mistake found after a ranked run was issued has already spent it.
 */
export function checkCapture(
  mapping: CaptureMapping,
  manifest: Manifest,
): string[] {
  const problems: string[] = []
  for (const [name, { kinds, sources }] of drivenBy(mapping)) {
    const declaration = Object.hasOwn(manifest.inputs, name)
      ? manifest.inputs[name]
      : undefined
    const from = sources.join(", ")
    if (declaration === undefined) {
      problems.push(
        `${from}: ${JSON.stringify(name)} is not an input the manifest declares`,
      )
      continue
    }
    if (kinds.size > 1) {
      problems.push(
        `${name} is driven as more than one kind of input (${from}); a name is a press, a position or an amount`,
      )
      continue
    }
    const kind = [...kinds][0] as Kind
    if (kind === "press" && (declaration.min > 0 || declaration.max < 1)) {
      problems.push(
        `${name} is pressed by ${from}, so its range must hold 0 and 1`,
      )
    }
    // A press may come from several places and is down while any is. A
    // level or an amount from two places would record one overwriting or
    // cancelling the other, and the recording could not say which.
    if (kind !== "press" && sources.length > 1) {
      problems.push(
        `${name} is driven by ${sources.join(" and ")}; a position or an amount has one source`,
      )
    }
    if (kind !== "press" && declaration.min === declaration.max) {
      problems.push(`${name} has a range of one value, so it records nothing`)
    }
    if (kind === "amount" && (declaration.min > 0 || declaration.max < 0)) {
      problems.push(`${name} is an amount, so its range must hold 0`)
    }
  }
  for (const code of Object.keys(mapping.keys ?? {})) {
    if (!KEYS.has(code)) {
      problems.push(
        `key ${JSON.stringify(code)} is not a KeyboardEvent.code value`,
      )
    }
  }
  const slots = mapping.pointers ?? []
  if (slots.length > POINTER_SLOTS) {
    problems.push(`${slots.length} pointer slots; at most ${POINTER_SLOTS}`)
  }
  slots.forEach((slot, s) => {
    for (const button of Object.keys(slot.buttons ?? {})) {
      if (button === "0" || !indexIn(button, POINTER_BUTTONS)) {
        problems.push(
          `pointer ${s} button ${button}: buttons are 1 to ${POINTER_BUTTONS - 1}, and the main button is down`,
        )
      }
    }
  })
  const pads = mapping.gamepads ?? {}
  for (const [slot, pad] of Object.entries(pads)) {
    if (slot !== "any" && !indexIn(slot, GAMEPAD_SLOTS)) {
      problems.push(
        `gamepad ${slot}: a slot is 0 to ${GAMEPAD_SLOTS - 1}, or "any"`,
      )
    }
    for (const b of [
      ...Object.keys(pad.buttons ?? {}),
      ...Object.keys(pad.values ?? {}),
    ]) {
      if (!indexIn(b, GAMEPAD_BUTTONS)) {
        problems.push(
          `gamepad ${slot} button ${b}: 0 to ${GAMEPAD_BUTTONS - 1}`,
        )
      }
    }
    for (const a of Object.keys(pad.axes ?? {})) {
      if (!indexIn(a, GAMEPAD_AXES)) {
        problems.push(`gamepad ${slot} axis ${a}: 0 to ${GAMEPAD_AXES - 1}`)
      }
    }
  }
  if (pads.any !== undefined && Object.keys(pads).length > 1) {
    problems.push(`gamepad "any" cannot sit beside numbered gamepads`)
  }
  for (const [what, value] of [
    ["mouseLock.pixelsPerUnit", mapping.mouseLock?.pixelsPerUnit],
    ["wheel.notchesPerUnit", mapping.wheel?.notchesPerUnit],
  ] as const) {
    if (value !== undefined && !(Number.isFinite(value) && value > 0)) {
      problems.push(`${what} must be a number above 0`)
    }
  }
  const fullAt = mapping.tilt?.fullAt
  if (fullAt !== undefined && !(fullAt > 0 && fullAt <= 90)) {
    problems.push("tilt.fullAt must be an angle above 0 and at most 90")
  }
  if (
    mapping.mouseLock !== undefined &&
    manifest.capabilities?.pointerLock !== true
  ) {
    problems.push(
      "mouse lock is mapped, so the manifest's capabilities.pointerLock must be true",
    )
  }
  return problems
}

/** `PointerEvent.buttons` bit for each `PointerEvent.button`. */
const BUTTON_BITS: readonly number[] = [1, 4, 2, 8, 16]

/** Wheel deltas per notch, by `WheelEvent.deltaMode`: pixels, lines, pages. */
const WHEEL_UNITS: readonly number[] = [100, 3, 1]

/** A stick reading inside this fraction of full deflection reads as centred. */
const STICK_DEADZONE = 0.08
/** Units `quantiseAxis` resolves a stick to before it is mapped onto a range. */
const STICK_STEPS = 1_000_000

/**
 * How far a tilt reading must move past the last recorded value, in units of
 * its range, before it is recorded. Without it a hand-held phone resting near
 * a unit boundary records an input on every reading.
 */
const TILT_DEADBAND = 0.75

const DEGREES = Math.PI / 180

/** A pointer holding a slot: its slot and the buttons it last had down. */
type Held = { readonly slot: number; buttons: number }

/** The parts of a `PointerEvent` the helpers read. */
type PointerLike = {
  readonly pointerId: number
  readonly pointerType?: string
  readonly clientX: number
  readonly clientY: number
  readonly buttons?: number
  readonly movementX?: number
  readonly movementY?: number
}

/** `fraction` (0 to 1) of the way across `declaration`'s range, rounded. */
function across(declaration: InputDeclaration, fraction: number): number {
  const f = Number.isFinite(fraction) ? Math.min(1, Math.max(0, fraction)) : 0
  return Math.round(declaration.min + f * (declaration.max - declaration.min))
}

/** The middle of a range, where a stick rests. */
function centre(declaration: InputDeclaration): number {
  return Math.round((declaration.min + declaration.max) / 2)
}

function editable(target: unknown): boolean {
  const element = target as {
    readonly tagName?: string
    readonly isContentEditable?: boolean
  } | null
  if (element === null || typeof element !== "object") return false
  if (element.isContentEditable === true) return true
  return ["INPUT", "TEXTAREA", "SELECT"].includes(element.tagName ?? "")
}

/**
 * Listens for device events and records them as the game's inputs.
 *
 * A key that is already held does not push again: an auto-repeating keydown
 * would put one input per repeat into the log, which is both wasteful and a
 * behaviour difference between operating systems.
 */
export class InputCapture {
  private readonly declarations: Manifest["inputs"]
  /** Which sources hold each press name down. */
  private readonly pressedBy = new Map<string, Set<string>>()
  /** pointerId to the slot it is down in. */
  private readonly slots = new Map<number, Held>()
  /** A lock asked for and not yet granted or refused. */
  private lockAsked = false
  /** The last value recorded per level name, so a repeat is not an input. */
  private readonly lastLevel = new Map<string, number>()
  /** Fractions of an amount not yet recorded. */
  private readonly remainder = new Map<string, number>()
  /** Gamepads by index, with the id last seen there. */
  private readonly pads = new Map<number, string>()
  private readonly listeners: Array<() => void> = []
  private gamepadsBlocked = false
  private enabled = false

  constructor(private readonly options: InputCaptureOptions) {
    const problems = checkCapture(options, options.manifest)
    if (problems.length > 0) {
      fail("E_ARG_INVALID", { detail: problems.join("; ") })
    }
    const needsElement =
      (options.pointers?.length ?? 0) > 0 ||
      options.hover !== undefined ||
      options.mouseLock !== undefined ||
      options.wheel !== undefined
    // A missing element is a game that cannot be touched, and it would build,
    // pass its checks and ship that way. So it is refused here, loudly.
    if (needsElement && options.element === undefined) {
      fail("E_ARG_INVALID", {
        detail:
          "pointers, hover, mouse lock or the wheel are mapped, so element is required",
      })
    }
    if (
      (options.gamepads !== undefined || options.mouseLock !== undefined) &&
      options.onNotice === undefined
    ) {
      fail("E_ARG_INVALID", {
        detail:
          "a gamepad or mouse lock is mapped, so onNotice is required to report a blocked device",
      })
    }
    this.declarations = options.manifest.inputs
    // A stick nobody has touched is centred and a trigger is up, which is
    // where the simulation should start them, so reading them there is not
    // an input.
    for (const pad of Object.values(options.gamepads ?? {})) {
      for (const name of Object.values(pad.axes ?? {})) {
        this.lastLevel.set(name, centre(this.declaration(name)))
      }
      for (const name of Object.values(pad.values ?? {})) {
        this.lastLevel.set(name, this.declaration(name).min)
      }
    }
  }

  private declaration(name: string): InputDeclaration {
    return this.declarations[name] as InputDeclaration
  }

  attach(): void {
    if (this.enabled) return
    this.enabled = true
    const environment = this.options.environment ?? browserEnvironment()
    const { window, document } = environment

    if (this.options.keys !== undefined) this.listenForKeys(window)
    this.listen(window, "blur", () => this.releaseAll())
    this.listen(document, "visibilitychange", () => {
      if (document.visibilityState === "hidden") this.releaseAll()
    })
    this.listeners.push(this.options.queue.onPause(() => this.releaseAll()))
    const element = this.options.element
    if (element !== undefined) {
      if (
        (this.options.pointers?.length ?? 0) > 0 ||
        this.options.hover !== undefined ||
        this.options.mouseLock !== undefined
      ) {
        this.listenForPointers(element, window, document)
      }
      if (this.options.wheel !== undefined) this.listenForWheel(element)
    }
    if (this.options.gamepads !== undefined) {
      this.listeners.push(
        this.options.queue.addPoller(() => this.readGamepads(environment)),
      )
    }
    if (this.options.tilt !== undefined) {
      this.listen(window, "deviceorientation", (event) => {
        // So a later `requestMotion` knows the sensor works without waiting
        // for a reading that changed.
        noteReading(window, event)
        this.tilt(event as DeviceOrientationEvent, environment)
      })
    }
  }

  private listen(
    target: EventTarget,
    name: string,
    listener: (event: Event) => void,
    options?: AddEventListenerOptions,
  ): void {
    target.addEventListener(name, listener, options)
    this.listeners.push(() => {
      target.removeEventListener(name, listener, options)
    })
  }

  private listenForKeys(window: EventTarget): void {
    const keys = this.options.keys ?? {}
    this.listen(window, "keydown", (event) => {
      const key = event as KeyboardEvent
      const name = keys[key.code]
      if (name === undefined) return
      // A key typed into a form on the page is the form's, not the game's.
      if (editable(key.target)) return
      key.preventDefault()
      if (key.repeat) return
      this.press(name, `key ${key.code}`, true)
    })
    // Never filtered: a key released anywhere comes up, or it is held for
    // the rest of the run.
    this.listen(window, "keyup", (event) => {
      const key = event as KeyboardEvent
      const name = keys[key.code]
      if (name !== undefined) this.press(name, `key ${key.code}`, false)
    })
  }

  private listenForPointers(
    element: HTMLElement,
    window: EventTarget,
    document: CaptureDocument,
  ): void {
    // A drag that starts on a drawn control must stay a drag. Without this
    // the browser takes a moving finger for a pan, sends `pointercancel`,
    // and the control lets go mid-press.
    const touchAction = element.style.touchAction
    element.style.touchAction = "none"
    this.listeners.push(() => {
      element.style.touchAction = touchAction
    })
    const locked = (): boolean =>
      this.options.mouseLock !== undefined &&
      document.pointerLockElement === element
    const capture = (pointerId: number): void => {
      // Under a lock the pointer is already held, and a capture there would
      // end the lock's clicks. A capture that fails must not lose the
      // press: the window backstop below releases it.
      if (locked()) return
      try {
        element.setPointerCapture(pointerId)
      } catch {
        // The press stands without the capture.
      }
    }

    this.listen(element, "pointerdown", (event) => {
      const pointer = event as unknown as PointerLike
      if (this.options.mouseLock !== undefined && !locked()) {
        this.requestLock(element)
      }
      const held = this.takeSlot(pointer.pointerId)
      if (held === undefined) return
      capture(pointer.pointerId)
      const slot = this.options.pointers?.[held.slot]
      // The position goes in before the press, so a game hit-testing its own
      // controls knows where the finger landed in the same tick it learns
      // that it landed.
      if (!locked()) this.position(element, pointer, slot?.x, slot?.y)
      this.press(slot?.down, `pointer ${held.slot} down`, true)
      this.buttons(held, pointer.buttons ?? 1)
    })
    this.listen(element, "pointermove", (event) => {
      const pointer = event as unknown as PointerLike
      if (locked()) {
        const perUnit = this.options.mouseLock?.pixelsPerUnit ?? 1
        this.amount(
          this.options.mouseLock?.dx,
          (pointer.movementX ?? 0) / perUnit,
        )
        this.amount(
          this.options.mouseLock?.dy,
          (pointer.movementY ?? 0) / perUnit,
        )
      }
      const held = this.slots.get(pointer.pointerId)
      if (held === undefined) {
        // A mouse or pen moving with nothing pressed. A finger cannot hover.
        if (pointer.pointerType !== "touch" && !locked()) {
          this.position(
            element,
            pointer,
            this.options.hover?.x,
            this.options.hover?.y,
          )
        }
        return
      }
      const slot = this.options.pointers?.[held.slot]
      if (!locked()) this.position(element, pointer, slot?.x, slot?.y)
      // A second mouse button pressed while one is held fires no
      // `pointerdown`, only a move with different `buttons`.
      this.buttons(held, pointer.buttons ?? held.buttons)
    })
    const release = (pointer: PointerLike, withPosition: boolean): void => {
      const held = this.slots.get(pointer.pointerId)
      if (held === undefined) return
      if (withPosition && !locked()) {
        const slot = this.options.pointers?.[held.slot]
        this.position(element, pointer, slot?.x, slot?.y)
      }
      this.letGo(pointer.pointerId, held)
    }
    this.listen(element, "pointerup", (event) => {
      release(event as unknown as PointerLike, true)
    })
    // Sent instead of `pointerup` when the browser takes the pointer away.
    this.listen(element, "pointercancel", (event) => {
      release(event as unknown as PointerLike, false)
    })
    // Sent after every `pointerup` too, for a pointer already released, so
    // it releases only a pointer still down and never takes a slot. One with
    // a button still down lost its capture to something else and takes it
    // back.
    this.listen(element, "lostpointercapture", (event) => {
      const pointer = event as unknown as PointerLike
      if (!this.slots.has(pointer.pointerId)) return
      if ((pointer.buttons ?? 0) !== 0) capture(pointer.pointerId)
      else release(pointer, false)
    })
    // The backstop: a release the element did not hear, because its capture
    // failed, still ends the press.
    for (const name of ["pointerup", "pointercancel"]) {
      this.listen(window, name, (event) => {
        release(event as unknown as PointerLike, false)
      })
    }
    const rightButtonMapped = (this.options.pointers ?? []).some(
      (slot) => slot.buttons?.["2"] !== undefined,
    )
    if (rightButtonMapped) {
      // The game uses the right button, so the browser's menu stays shut.
      this.listen(element, "contextmenu", (event) => event.preventDefault())
    }
    if (this.options.mouseLock !== undefined) {
      this.listen(document, "pointerlockchange", () => {
        if (locked()) this.lockAsked = false
        else this.releaseAll()
      })
      // Firefox answers a request with nothing and refuses only here.
      this.listen(document, "pointerlockerror", () => {
        this.lockRefused("the browser refused to lock the mouse to the game")
      })
    }
  }

  private requestLock(element: HTMLElement): void {
    this.lockAsked = true
    try {
      // Chromium and WebKit answer with a promise, and WebKit also sends
      // `pointerlockerror`; Firefox answers with nothing.
      const answer = element.requestPointerLock() as unknown
      if (answer instanceof Promise) {
        answer.catch((reason: unknown) => this.lockRefused(reason))
      }
    } catch (reason) {
      this.lockRefused(reason)
    }
  }

  /** One notice per request, however many ways the browser says no. */
  private lockRefused(reason: unknown): void {
    if (!this.lockAsked) return
    this.lockAsked = false
    this.notice(DEVICE_NOTICES.POINTER_LOCK_REFUSED, String(reason))
  }

  /** The lowest free slot, taken only when a pointer goes down. */
  private takeSlot(pointerId: number): Held | undefined {
    const existing = this.slots.get(pointerId)
    if (existing !== undefined) return existing
    const taken = new Set([...this.slots.values()].map((held) => held.slot))
    let slot = 0
    while (taken.has(slot)) slot += 1
    // A finger past the last slot is dropped, as an unmapped key is.
    if (slot >= POINTER_SLOTS) return undefined
    const held: Held = { slot, buttons: 0 }
    this.slots.set(pointerId, held)
    return held
  }

  private letGo(pointerId: number, held: Held): void {
    this.buttons(held, 0)
    const slot = this.options.pointers?.[held.slot]
    this.press(slot?.down, `pointer ${held.slot} down`, false)
    this.slots.delete(pointerId)
  }

  /** Presses and releases each mouse or pen button whose bit changed. */
  private buttons(held: Held, buttons: number): void {
    const mapped = this.options.pointers?.[held.slot]?.buttons ?? {}
    for (let button = 1; button < POINTER_BUTTONS; button++) {
      const bit = BUTTON_BITS[button] as number
      const now = buttons & bit
      if (now === (held.buttons & bit)) continue
      this.press(
        mapped[String(button)],
        `pointer ${held.slot} button ${button}`,
        now !== 0,
      )
    }
    held.buttons = buttons
  }

  /** Where the pointer is across the element, in each name's own range. */
  private position(
    element: HTMLElement,
    pointer: PointerLike,
    x: string | undefined,
    y: string | undefined,
  ): void {
    if (x === undefined && y === undefined) return
    const bounds = element.getBoundingClientRect()
    if (x !== undefined && bounds.width > 0) {
      this.level(
        x,
        across(
          this.declaration(x),
          (pointer.clientX - bounds.left) / bounds.width,
        ),
      )
    }
    if (y !== undefined && bounds.height > 0) {
      this.level(
        y,
        across(
          this.declaration(y),
          (pointer.clientY - bounds.top) / bounds.height,
        ),
      )
    }
  }

  private listenForWheel(element: HTMLElement): void {
    const wheel = this.options.wheel
    const perUnit = wheel?.notchesPerUnit ?? 1
    this.listen(
      element,
      "wheel",
      (event) => {
        const scroll = event as WheelEvent
        // Read first: Firefox reports lines only to a listener that asks for
        // the mode before it reads a delta, and pixels otherwise.
        const mode = scroll.deltaMode
        const perNotch = WHEEL_UNITS[mode]
        if (perNotch === undefined) return
        // A wheel over the game is the game's, not the page's.
        scroll.preventDefault()
        this.amount(wheel?.x, scroll.deltaX / perNotch / perUnit)
        this.amount(wheel?.y, scroll.deltaY / perNotch / perUnit)
      },
      // Passive unless it says otherwise on some targets, and a passive
      // listener cannot stop the page scrolling.
      { passive: false },
    )
  }

  /** Adds `amount` to what is owed, and records the whole part of it. */
  private amount(name: string | undefined, amount: number): void {
    if (name === undefined || !Number.isFinite(amount) || amount === 0) return
    const owed = (this.remainder.get(name) ?? 0) + amount
    const whole = Math.trunc(owed)
    this.remainder.set(name, owed - whole)
    if (whole !== 0) this.push(name, whole, "sum")
  }

  private readGamepads(environment: CaptureEnvironment): void {
    if (this.gamepadsBlocked) return
    let pads: readonly (Gamepad | null)[]
    try {
      pads = environment.gamepads()
    } catch (reason) {
      // The page's own policy forbids gamepads. Said once, and the run goes
      // on: a player on keys or touch is unaffected.
      this.gamepadsBlocked = true
      this.notice(DEVICE_NOTICES.GAMEPAD_BLOCKED, String(reason))
      return
    }
    const connected = pads.filter(
      (pad): pad is Gamepad =>
        pad?.connected === true && pad.index >= 0 && pad.index < GAMEPAD_SLOTS,
    )
    for (const pad of connected) {
      if (this.pads.get(pad.index) === pad.id) continue
      this.pads.set(pad.index, pad.id)
      if (pad.mapping !== "standard") {
        this.notice(
          DEVICE_NOTICES.GAMEPAD_UNMAPPED,
          `gamepad ${pad.index} (${pad.id}) has no standard layout`,
        )
      }
    }
    const gamepads = this.options.gamepads ?? {}
    const any = gamepads.any
    // With "any", the first connected pad plays; the others are spectators.
    const playing =
      any !== undefined
        ? connected.slice(0, 1).map((pad) => [pad, any] as const)
        : connected.flatMap((pad) => {
            const mapping = gamepads[String(pad.index)]
            return mapping === undefined ? [] : [[pad, mapping] as const]
          })
    for (const [pad, mapping] of playing) this.readPad(pad, mapping)
    for (const index of [...this.pads.keys()]) {
      if (connected.some((pad) => pad.index === index)) continue
      this.pads.delete(index)
      const mapping = any ?? gamepads[String(index)]
      if (mapping !== undefined) this.restPad(mapping, index)
    }
  }

  private readPad(pad: Gamepad, mapping: GamepadMapping): void {
    const source = `gamepad ${mapping === this.options.gamepads?.any ? "any" : pad.index}`
    for (const [b, name] of Object.entries(mapping.buttons ?? {})) {
      this.press(
        name,
        `${source} button ${b}`,
        pad.buttons[Number(b)]?.pressed === true,
      )
    }
    for (const [b, name] of Object.entries(mapping.values ?? {})) {
      this.level(
        name,
        across(this.declaration(name), pad.buttons[Number(b)]?.value ?? 0),
        "latest",
      )
    }
    for (const [a, name] of Object.entries(mapping.axes ?? {})) {
      const reading = quantiseAxis(pad.axes[Number(a)] ?? 0, {
        deadzone: STICK_DEADZONE,
        scale: STICK_STEPS,
      })
      this.level(
        name,
        across(this.declaration(name), (reading / STICK_STEPS + 1) / 2),
        "latest",
      )
    }
  }

  /** A controller went away: its buttons come up and its sticks centre. */
  private restPad(mapping: GamepadMapping, index: number): void {
    const source = `gamepad ${mapping === this.options.gamepads?.any ? "any" : index}`
    for (const [b, name] of Object.entries(mapping.buttons ?? {})) {
      this.press(name, `${source} button ${b}`, false)
    }
    this.restLevels(mapping)
  }

  private restLevels(mapping: GamepadMapping): void {
    for (const name of Object.values(mapping.axes ?? {})) {
      this.level(name, centre(this.declaration(name)), "latest")
    }
    for (const name of Object.values(mapping.values ?? {})) {
      this.level(name, this.declaration(name).min, "latest")
    }
  }

  private tilt(
    event: DeviceOrientationEvent,
    environment: CaptureEnvironment,
  ): void {
    const tilt = this.options.tilt
    if (tilt === undefined || !event.isTrusted) return
    const { beta, gamma } = event
    const angle = screenRotation(environment.screenAngle())
    // A malformed reading is dropped, never recorded: a null from a device
    // with no sensor would otherwise read as lying flat, a position nobody
    // held.
    if (
      beta === null ||
      gamma === null ||
      !Number.isFinite(beta) ||
      !Number.isFinite(gamma) ||
      beta < -180 ||
      beta > 180 ||
      gamma < -90 ||
      gamma > 90 ||
      angle === undefined
    ) {
      return
    }
    // Gravity in the device's own axes (x right, y up, z out of the screen)
    // for a device turned by beta about x and then gamma about y.
    const b = beta * DEGREES
    const g = gamma * DEGREES
    const x = Math.sin(g) * Math.cos(b)
    const y = -Math.sin(b)
    const z = -Math.cos(g) * Math.cos(b)
    // Then into the screen's axes, which turn with the screen.
    const t = angle * DEGREES
    const screenX = x * Math.cos(t) - y * Math.sin(t)
    const screenY = x * Math.sin(t) + y * Math.cos(t)
    const full = Math.sin((tilt.fullAt ?? 90) * DEGREES)
    this.tiltAxis(tilt.x, screenX / full)
    this.tiltAxis(tilt.y, screenY / full)
    this.tiltAxis(tilt.z, z / full)
  }

  private tiltAxis(name: string | undefined, gravity: number): void {
    if (name === undefined) return
    const declaration = this.declaration(name)
    const fraction = (Math.min(1, Math.max(-1, gravity)) + 1) / 2
    const units =
      declaration.min + fraction * (declaration.max - declaration.min)
    const last = this.lastLevel.get(name)
    if (last !== undefined && Math.abs(units - last) <= TILT_DEADBAND) return
    this.level(name, Math.round(units), "latest")
  }

  private notice(code: DeviceNoticeCode, detail: string): void {
    this.options.onNotice?.({ code, detail })
  }

  /** A value that holds until it changes: a repeat is not an input. */
  private level(
    name: string,
    value: number,
    merge: MergeRule = "latest",
  ): void {
    if (this.lastLevel.get(name) === value) return
    this.lastLevel.set(name, value)
    this.push(name, value, merge)
  }

  /** A press is down while any of its sources holds it. */
  private press(name: string | undefined, source: string, down: boolean): void {
    if (name === undefined) return
    const holders = this.pressedBy.get(name) ?? new Set<string>()
    const wasDown = holders.size > 0
    if (down) holders.add(source)
    else holders.delete(source)
    this.pressedBy.set(name, holders)
    const isDown = holders.size > 0
    if (isDown !== wasDown) this.push(name, isDown ? 1 : 0)
  }

  private push(name: string, value: number, merge?: MergeRule): void {
    this.options.queue.push({
      code: name,
      value,
      ...(merge === undefined ? {} : { merge }),
    })
  }

  /**
   * Releases everything held, so a session that loses focus or pauses does
   * not stick: keys and buttons come up, sticks centre, and the pointers'
   * slots are freed. A controller button still physically down is pressed
   * again by the next poll, which is right: it is down.
   */
  releaseAll(): void {
    for (const [pointerId, held] of [...this.slots]) this.letGo(pointerId, held)
    for (const [name, holders] of this.pressedBy) {
      if (holders.size === 0) continue
      holders.clear()
      this.push(name, 0)
    }
    for (const mapping of Object.values(this.options.gamepads ?? {})) {
      this.restLevels(mapping)
    }
    this.remainder.clear()
  }

  detach(): void {
    this.releaseAll()
    for (const remove of this.listeners) remove()
    this.listeners.length = 0
    this.enabled = false
  }
}

/**
 * The screen's rotation from the device's natural orientation, in degrees,
 * as the tilt maths needs it, or undefined when the browser cannot say.
 *
 * One function, so a platform whose `screen.orientation.angle` is measured
 * against a different frame from its orientation events gets one rule here.
 * On an iPad, WebKit reports 90 in portrait; whether that matches the frame
 * its `deviceorientation` uses is not yet measured, so iPad tilt is
 * unverified and no correction is applied.
 */
export function screenRotation(
  angle: number | undefined,
): 0 | 90 | 180 | 270 | undefined {
  if (angle === undefined || !Number.isFinite(angle)) return undefined
  const turned = ((Math.round(angle) % 360) + 360) % 360
  return turned === 0 || turned === 90 || turned === 180 || turned === 270
    ? turned
    : undefined
}

function browserEnvironment(): CaptureEnvironment {
  const scope = globalThis as unknown as {
    readonly document: CaptureDocument
    readonly navigator: { getGamepads(): readonly (Gamepad | null)[] }
    readonly screen?: { readonly orientation?: { readonly angle?: number } }
  }
  return {
    window: globalThis,
    document: scope.document,
    gamepads: () => scope.navigator.getGamepads(),
    screenAngle: () => scope.screen?.orientation?.angle,
  }
}
