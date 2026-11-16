/**
 * Turning device events into simulation inputs.
 *
 * This lives in the host, not in the game. A game draws its own controls,
 * and the host records only what a player's devices did: which key, where a
 * finger is, how far a stick is pushed. The game decides in `tick` what that
 * meant, from the recorded positions, so the decision replays on a server.
 * A game that worked out in its renderer which control was pressed and
 * handed the answer over would replay perfectly and still decide the result
 * on the client, and no conformance check could see it.
 *
 * Only what the manifest binds is listened for and recorded, so each game
 * decides what its recording holds.
 *
 * Every press the host records it also releases. A finger that slides off
 * the game, a mouse released over another page, a tab put in the background,
 * a controller unplugged: each ends the press in the log. A press that never
 * ends is a game that runs into a wall for the rest of the session.
 */

import { fail } from "../errors.js"
import {
  AXIS_UNITS,
  type CodeSpec,
  describeCode,
  GAMEPAD_SLOTS,
  type InputDevice,
  type InputSink,
  type Manifest,
  type MergeRule,
  POINTER_BUTTONS,
  POINTER_SLOTS,
  quantiseAxis,
  quantisePoint,
  TILT_UNITS,
  TRIGGER_UNITS,
  type Viewport,
} from "../index.js"

export type ActionBinding = {
  readonly action: string
  readonly device: InputDevice
  readonly spec: CodeSpec
}

/**
 * Builds a device-code to action lookup from the manifest. A code no device
 * produces is left out: the validator refuses it, and a host given an
 * unvalidated manifest must not invent a meaning for it.
 */
export function bindingsFrom(
  manifest: Manifest,
): ReadonlyMap<string, ActionBinding> {
  const map = new Map<string, ActionBinding>()
  for (const [action, bindings] of Object.entries(manifest.inputs.map)) {
    for (const binding of bindings) {
      const spec = describeCode(binding.code)
      if (spec === undefined) continue
      map.set(binding.code, { action, device: spec.device, spec })
    }
  }
  return map
}

/** One tilt reading as the page hosting a game hears it, in degrees. */
export interface MotionReading {
  /** Front-to-back tilt, `DeviceOrientationEvent.beta`, in [-180, 180]. */
  readonly beta: number
  /** Left-to-right tilt, `DeviceOrientationEvent.gamma`, in [-90, 90]. */
  readonly gamma: number
  /** How far the screen is turned from the device's natural orientation. */
  readonly angle: 0 | 90 | 180 | 270
}

/** Where tilt comes from. The frame bridge is one: the page reads the sensor. */
export interface MotionSource {
  onMotion(listener: (reading: MotionReading) => void): () => void
}

/**
 * Something about a device the page should tell the player, which does not
 * stop the run: a player on keys or touch plays on whatever a controller
 * does.
 */
export const DEVICE_NOTICES = {
  /** The page hosting the game forbids gamepads, so none is read. */
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

/** What `InputCapture` needs from a document. */
export interface CaptureDocument extends EventTarget {
  readonly visibilityState?: string
  readonly pointerLockElement?: Element | null
  exitPointerLock?(): void
}

/** The browser, for a test to stand in for. Read when `attach` runs, never at import. */
export interface CaptureEnvironment {
  /** Hears `blur` and `wheel`. */
  readonly window: EventTarget
  /** Hears `visibilitychange` and `pointerlockchange`. */
  readonly document: CaptureDocument
  /** `navigator.getGamepads`. */
  readonly gamepads: () => readonly (Gamepad | null)[]
}

export interface InputCaptureOptions {
  readonly manifest: Manifest
  /** Where inputs go: a session's live queue, or a worker's. */
  readonly queue: InputSink
  /** Where key events are listened for. The frame's window by default. */
  readonly keyTarget?: EventTarget
  /**
   * The element the game is drawn on. A pointer's position is measured
   * across it in `inputs.viewport` units, on each axis separately, so it
   * must be the element the playfield fills, stretched the same way.
   * Required when the manifest binds a pointer code.
   */
  readonly pointerTarget?: HTMLElement
  /** Required when the manifest binds a tilt code. */
  readonly motion?: MotionSource
  /** Required when the manifest binds a gamepad code or mouse movement. */
  readonly onNotice?: (notice: DeviceNotice) => void
  /** For a test. The browser's own by default. */
  readonly environment?: CaptureEnvironment
}

/** `PointerEvent.buttons` bit for each `PointerEvent.button`. */
const BUTTON_BITS: readonly number[] = [1, 4, 2, 8, 16]

/** Wheel deltas per notch, by `WheelEvent.deltaMode`: pixels, lines, pages. */
const WHEEL_UNITS: readonly number[] = [100, 3, 1]

/**
 * How far a tilt reading must move past the last recorded value, in units,
 * before it is recorded. Without it a hand-held phone resting near a unit
 * boundary records an input on every reading.
 */
const TILT_DEADBAND = 0.75

const DEGREES = Math.PI / 180

/** A pointer holding a slot: its slot and the buttons it last had down. */
type Held = { readonly slot: number; buttons: number }

/** The parts of a `PointerEvent` the capture reads. */
type PointerLike = {
  readonly type: string
  readonly pointerId: number
  readonly pointerType?: string
  readonly clientX: number
  readonly clientY: number
  readonly buttons?: number
  readonly movementX?: number
  readonly movementY?: number
}

/**
 * Listens for device events and pushes actions onto the queue.
 *
 * A key that is already held does not push again: an auto-repeating keydown
 * would put one input per repeat into the log, which is both wasteful and a
 * behaviour difference between operating systems.
 */
export class InputCapture {
  private readonly bindings: ReadonlyMap<string, ActionBinding>
  private readonly viewport: Viewport | undefined
  private readonly bound = new Set<InputDevice>()
  private readonly held = new Set<string>()
  /** pointerId to the slot its codes are spelled with, while it is down. */
  private readonly slots = new Map<number, Held>()
  /** The last value pushed per level code, so a repeat is not an input. */
  private readonly lastLevel = new Map<string, number>()
  /** Fractions of a wheel notch or a mouse pixel not yet recorded. */
  private readonly remainder = new Map<string, number>()
  /** Gamepads by index, with the id last seen there, for disconnects. */
  private readonly pads = new Map<number, string>()
  private readonly listeners: Array<() => void> = []
  private wantsLock = false
  private gamepadsBlocked = false
  private enabled = false

  constructor(private readonly options: InputCaptureOptions) {
    this.bindings = bindingsFrom(options.manifest)
    this.viewport = options.manifest.inputs.viewport
    let coordinates = false
    for (const [code, binding] of this.bindings) {
      this.bound.add(binding.device)
      if (typeof binding.spec.max !== "number") coordinates = true
      if (code === "mouse-dx" || code === "mouse-dy") this.wantsLock = true
      // A stick nobody has touched is centred, which is what the simulation
      // assumes, so its first reading of the centre is not an input.
      if (binding.spec.rest !== undefined) {
        this.lastLevel.set(code, binding.spec.rest)
      }
    }
    // A missing target is a game that cannot be touched, and it would build,
    // pass conformance and ship that way. So it is refused here, loudly.
    if (this.bound.has("pointer") && options.pointerTarget === undefined) {
      fail("E_ARG_INVALID", {
        detail:
          "the manifest binds a pointer code, so pointerTarget is required",
      })
    }
    if (coordinates && this.viewport === undefined) {
      fail("E_ARG_INVALID", {
        detail: "the manifest binds a pointer position without inputs.viewport",
      })
    }
    if (this.bound.has("motion") && options.motion === undefined) {
      fail("E_ARG_INVALID", {
        detail:
          "the manifest binds a tilt code, so a motion source is required",
      })
    }
    if (
      (this.bound.has("gamepad") || this.wantsLock) &&
      options.onNotice === undefined
    ) {
      fail("E_ARG_INVALID", {
        detail:
          "the manifest binds a gamepad or mouse movement, so onNotice is required to report a blocked device",
      })
    }
  }

  /** The device codes this game listens for, for a controls card. */
  get codes(): readonly string[] {
    return [...this.bindings.keys()]
  }

  attach(): void {
    if (this.enabled) return
    this.enabled = true
    const environment = this.options.environment ?? browserEnvironment()

    if (this.bound.has("key")) this.listenForKeys()
    this.listen(environment.window, "blur", () => this.releaseAll())
    this.listen(environment.document, "visibilitychange", () => {
      if (environment.document.visibilityState === "hidden") this.releaseAll()
    })
    const target = this.options.pointerTarget
    if (target !== undefined && this.bound.has("pointer")) {
      this.listenForPointers(target, environment.document)
    }
    if (this.bound.has("wheel")) this.listenForWheel(environment.window)
    if (this.bound.has("gamepad")) this.pollGamepads(environment)
    const motion = this.options.motion
    if (motion !== undefined && this.bound.has("motion")) {
      this.listeners.push(motion.onMotion((reading) => this.tilt(reading)))
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

  private listenForKeys(): void {
    const keyTarget = this.options.keyTarget ?? globalThis
    this.listen(keyTarget, "keydown", (event) => {
      const key = event as KeyboardEvent
      if (key.repeat) return
      this.press(key.code, 1)
    })
    this.listen(keyTarget, "keyup", (event) => {
      this.press((event as KeyboardEvent).code, 0)
    })
  }

  private listenForPointers(
    target: HTMLElement,
    document: CaptureDocument,
  ): void {
    // A drag that starts on a drawn control must stay a drag. Without this
    // the browser takes a moving finger for a pan, sends `pointercancel`,
    // and the control lets go mid-press. It is set here because
    // `touch-action` does not cascade into a frame from the page around it.
    const touchAction = target.style.touchAction
    target.style.touchAction = "none"
    this.listeners.push(() => {
      target.style.touchAction = touchAction
    })

    this.listen(target, "pointerdown", (event) => {
      const pointer = event as unknown as PointerLike
      const slot = this.takeSlot(pointer.pointerId)
      if (slot === undefined) return
      // Every move and the release now come here, wherever the pointer goes:
      // a mouse is not captured on its own the way a finger is, and released
      // over the page around the game it would otherwise never come up.
      target.setPointerCapture(pointer.pointerId)
      if (this.wantsLock && !this.locked(target, document)) {
        this.requestLock(target)
      }
      // The position goes in before the press, so a game hit-testing its own
      // controls knows where the finger landed in the same tick it learns
      // that it landed.
      if (!this.locked(target, document)) {
        this.position(target, pointer, `pointer${slot.slot}`)
      }
      this.press(`pointer${slot.slot}`, 1)
      this.buttons(slot, pointer.buttons ?? 1)
    })
    this.listen(target, "pointermove", (event) => {
      const pointer = event as unknown as PointerLike
      if (this.locked(target, document)) {
        this.move("mouse-dx", pointer.movementX ?? 0)
        this.move("mouse-dy", pointer.movementY ?? 0)
      }
      const held = this.slots.get(pointer.pointerId)
      if (held === undefined) {
        // A mouse or pen moving with nothing pressed. A finger cannot hover.
        if (pointer.pointerType !== "touch" && !this.locked(target, document)) {
          this.position(target, pointer, "hover")
        }
        return
      }
      if (!this.locked(target, document)) {
        this.position(target, pointer, `pointer${held.slot}`)
      }
      // A second mouse button pressed while one is held fires no
      // `pointerdown`, only a move with different `buttons`.
      this.buttons(held, pointer.buttons ?? held.buttons)
    })
    const release = (event: Event, withPosition: boolean): void => {
      const pointer = event as unknown as PointerLike
      const held = this.slots.get(pointer.pointerId)
      if (held === undefined) return
      if (withPosition && !this.locked(target, document)) {
        this.position(target, pointer, `pointer${held.slot}`)
      }
      this.letGo(pointer.pointerId, held)
    }
    this.listen(target, "pointerup", (event) => release(event, true))
    // The browser sends this instead of `pointerup` when it takes the
    // pointer away. Without it that slot stays held for the session.
    this.listen(target, "pointercancel", (event) => release(event, false))
    // Sent after every `pointerup` too, for a pointer whose slot is already
    // free, so it must release only a pointer still holding one and never
    // take a new slot: otherwise slot 0 would stay taken after the first tap.
    this.listen(target, "lostpointercapture", (event) => release(event, false))

    if ([...this.bindings.keys()].some((code) => code.endsWith("-button2"))) {
      // The game uses the right button, so the browser's menu stays shut.
      this.listen(target, "contextmenu", (event) => event.preventDefault())
    }
    if (this.wantsLock) {
      this.listen(document, "pointerlockchange", () => {
        if (!this.locked(target, document)) this.releaseAll()
      })
    }
  }

  private locked(target: HTMLElement, document: CaptureDocument): boolean {
    return this.wantsLock && document.pointerLockElement === target
  }

  private requestLock(target: HTMLElement): void {
    const refused = (reason: unknown): void => {
      this.notice(DEVICE_NOTICES.POINTER_LOCK_REFUSED, String(reason))
    }
    try {
      // Chromium answers with a promise; WebKit and Firefox with nothing,
      // and a refusal there arrives as `pointerlockerror`.
      const answer = target.requestPointerLock() as unknown
      if (answer instanceof Promise) answer.catch(refused)
    } catch (reason) {
      refused(reason)
    }
  }

  /** The lowest free slot, taken only when a pointer goes down. */
  private takeSlot(pointerId: number): Held | undefined {
    const existing = this.slots.get(pointerId)
    if (existing !== undefined) return existing
    const taken = new Set([...this.slots.values()].map((held) => held.slot))
    let slot = 0
    while (taken.has(slot)) slot += 1
    // A finger past the last slot is dropped, as an unbound key is.
    if (slot >= POINTER_SLOTS) return undefined
    const held: Held = { slot, buttons: 0 }
    this.slots.set(pointerId, held)
    return held
  }

  private letGo(pointerId: number, held: Held): void {
    this.buttons(held, 0)
    this.press(`pointer${held.slot}`, 0)
    this.slots.delete(pointerId)
    // The next finger into this slot reports where it is, rather than having
    // its first coordinate suppressed as unchanged from the last one's.
    this.lastLevel.delete(`pointer${held.slot}-x`)
    this.lastLevel.delete(`pointer${held.slot}-y`)
  }

  /** Presses and releases each mouse or pen button whose bit changed. */
  private buttons(held: Held, buttons: number): void {
    for (let button = 0; button < POINTER_BUTTONS; button++) {
      const bit = BUTTON_BITS[button] as number
      const now = buttons & bit
      if (now === (held.buttons & bit)) continue
      this.press(`pointer${held.slot}-button${button}`, now === 0 ? 0 : 1)
    }
    held.buttons = buttons
  }

  /** Quantised here, so the simulation never sees a CSS pixel. */
  private position(
    target: HTMLElement,
    pointer: PointerLike,
    prefix: string,
  ): void {
    const viewport = this.viewport
    if (viewport === undefined) return
    const bounds = target.getBoundingClientRect()
    this.level(
      `${prefix}-x`,
      quantisePoint(
        pointer.clientX - bounds.left,
        bounds.width,
        viewport.width,
      ),
    )
    this.level(
      `${prefix}-y`,
      quantisePoint(
        pointer.clientY - bounds.top,
        bounds.height,
        viewport.height,
      ),
    )
  }

  /** Mouse movement while locked: whole pixels, the fractions carried. */
  private move(code: string, amount: number): void {
    if (!this.bindings.has(code) || !Number.isFinite(amount)) return
    this.impulse(code, amount)
  }

  private listenForWheel(window: EventTarget): void {
    this.listen(
      window,
      "wheel",
      (event) => {
        const wheel = event as WheelEvent
        // Read first: Firefox reports lines only to a listener that asks
        // for the mode before it reads a delta, and pixels otherwise.
        const mode = wheel.deltaMode
        const perNotch = WHEEL_UNITS[mode]
        if (perNotch === undefined) return
        // The frame is the game, and a wheel over it is the game's.
        wheel.preventDefault()
        this.wheel("wheel-x", wheel.deltaX / perNotch)
        this.wheel("wheel-y", wheel.deltaY / perNotch)
      },
      // A wheel listener on a window is passive unless it says otherwise,
      // and a passive listener cannot stop the page scrolling.
      { passive: false },
    )
  }

  private wheel(code: string, notches: number): void {
    if (!this.bindings.has(code) || !Number.isFinite(notches)) return
    this.impulse(code, notches)
  }

  /** Adds `amount` to what is owed, and records the whole part of it. */
  private impulse(code: string, amount: number): void {
    const owed = (this.remainder.get(code) ?? 0) + amount
    const whole = Math.trunc(owed)
    this.remainder.set(code, owed - whole)
    if (whole !== 0) this.push(code, whole, "sum")
  }

  private pollGamepads(environment: CaptureEnvironment): void {
    this.listeners.push(
      this.options.queue.addPoller(() => this.readGamepads(environment)),
    )
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
    const seen = new Set<number>()
    for (const pad of pads) {
      if (pad === null || !pad.connected) continue
      if (pad.index < 0 || pad.index >= GAMEPAD_SLOTS) continue
      seen.add(pad.index)
      if (this.pads.get(pad.index) !== pad.id) {
        this.pads.set(pad.index, pad.id)
        if (pad.mapping !== "standard") {
          this.notice(
            DEVICE_NOTICES.GAMEPAD_UNMAPPED,
            `gamepad ${pad.index} (${pad.id}) has no standard layout`,
          )
        }
      }
      this.readPad(pad)
    }
    for (const index of [...this.pads.keys()]) {
      if (seen.has(index)) continue
      this.pads.delete(index)
      this.restPad(index)
    }
  }

  private readPad(pad: Gamepad): void {
    const prefix = `gamepad${pad.index}`
    pad.buttons.forEach((button, b) => {
      this.press(`${prefix}-button${b}`, button.pressed ? 1 : 0)
      this.level(
        `${prefix}-button${b}-value`,
        Math.round(clamp(button.value, 0, 1) * TRIGGER_UNITS),
        "latest",
      )
    })
    pad.axes.forEach((value, a) => {
      this.level(
        `${prefix}-axis${a}`,
        quantiseAxis(value, { scale: AXIS_UNITS }),
        "latest",
      )
    })
  }

  /** A controller went away: its buttons come up and its sticks centre. */
  private restPad(index: number): void {
    const prefix = `gamepad${index}-`
    for (const [code, binding] of this.bindings) {
      if (!code.startsWith(prefix)) continue
      this.rest(code, binding.spec)
    }
  }

  /** Ends a press, or returns a level to its rest value. */
  private rest(code: string, spec: CodeSpec): void {
    if (spec.kind === "press") {
      this.press(code, 0)
    } else if (spec.rest !== undefined) {
      this.level(code, spec.rest, "latest")
    }
  }

  private tilt(reading: MotionReading): void {
    const { beta, gamma, angle } = reading
    // A malformed reading is dropped, never quantised: a null from a device
    // with no sensor would otherwise read as lying flat, which is a real
    // position nobody held.
    if (
      !Number.isFinite(beta) ||
      !Number.isFinite(gamma) ||
      beta < -180 ||
      beta > 180 ||
      gamma < -90 ||
      gamma > 90 ||
      ![0, 90, 180, 270].includes(angle)
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
    this.tiltAxis("tilt-x", screenX)
    this.tiltAxis("tilt-y", screenY)
    this.tiltAxis("tilt-z", z)
  }

  private tiltAxis(code: string, gravity: number): void {
    if (!this.bindings.has(code)) return
    const units = clamp(gravity, -1, 1) * TILT_UNITS
    const last = this.lastLevel.get(code)
    if (last !== undefined && Math.abs(units - last) <= TILT_DEADBAND) return
    this.level(code, Math.round(units), "latest")
  }

  private notice(code: DeviceNoticeCode, detail: string): void {
    this.options.onNotice?.({ code, detail })
  }

  /** A value that holds until it changes: a repeat is not an input. */
  private level(code: string, value: number, merge?: MergeRule): void {
    if (!this.bindings.has(code)) return
    if (this.lastLevel.get(code) === value) return
    this.lastLevel.set(code, value)
    this.push(code, value, merge)
  }

  private press(code: string, value: number): void {
    if (!this.bindings.has(code)) return
    if (value === 1) {
      if (this.held.has(code)) return
      this.held.add(code)
    } else {
      if (!this.held.has(code)) return
      this.held.delete(code)
    }
    this.push(code, value)
  }

  private push(code: string, value: number, merge?: MergeRule): void {
    const binding = this.bindings.get(code)
    if (binding === undefined) return
    this.options.queue.push({
      device: binding.device,
      code: binding.action,
      value,
      ...(merge === undefined ? {} : { merge }),
    })
  }

  /**
   * Releases everything held, so a session that loses focus does not stick:
   * keys and buttons come up, sticks centre, and the pointers' slots are
   * freed. A controller button still physically down is pressed again by
   * the next poll, which is right: it is down.
   */
  releaseAll(): void {
    for (const [pointerId, held] of [...this.slots]) {
      this.letGo(pointerId, held)
    }
    for (const code of [...this.held]) this.press(code, 0)
    for (const [code, binding] of this.bindings) {
      if (binding.spec.rest !== undefined) this.rest(code, binding.spec)
    }
    this.remainder.clear()
    // Forgotten rather than kept: after a gap the simulation should be told
    // where the pointer is when it comes back, not have it suppressed as
    // unchanged from before.
    for (const code of [...this.lastLevel.keys()]) {
      if (code.startsWith("pointer") || code.startsWith("hover")) {
        this.lastLevel.delete(code)
      }
    }
  }

  detach(): void {
    this.releaseAll()
    for (const remove of this.listeners) remove()
    this.listeners.length = 0
    this.enabled = false
  }
}

function clamp(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min < 0 ? 0 : min
  return value < min ? min : value > max ? max : value
}

function browserEnvironment(): CaptureEnvironment {
  return {
    window: globalThis,
    document: globalThis.document,
    gamepads: () => globalThis.navigator.getGamepads(),
  }
}
