/**
 * Turning device events into simulation inputs.
 *
 * This lives in the host, not in the game, and that is the whole point. A game
 * that could build its own input events could do its hit-testing in the
 * renderer and hand the answer to the simulation as a virtual press. That
 * replays perfectly and still decides the result on the client, and no
 * conformance check can see it. So the game receives inputs and never makes
 * one.
 */

import {
  type InputDevice,
  type LiveInputQueue,
  type Manifest,
  quantisePoint,
} from "../index.js"

export type ActionBinding = {
  readonly action: string
  readonly device: InputDevice
}

/** Builds a device-code to action lookup from the manifest. */
export function bindingsFrom(
  manifest: Manifest,
): ReadonlyMap<string, ActionBinding> {
  const map = new Map<string, ActionBinding>()
  for (const [action, bindings] of Object.entries(manifest.inputs.map)) {
    for (const binding of bindings) {
      map.set(binding.code, { action, device: binding.device })
    }
  }
  return map
}

export interface InputCaptureOptions {
  readonly manifest: Manifest
  readonly queue: LiveInputQueue
  /** Where key events are listened for. Defaults to the container's document. */
  readonly keyTarget?: EventTarget
  /** Where pointer events are listened for. */
  readonly pointerTarget?: HTMLElement
  /** The simulation's coordinate space, for mapping a pointer into it. */
  readonly viewport?: { readonly width: number; readonly height: number }
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
  private readonly held = new Set<string>()
  /** pointerId to the small slot number its device codes are spelled with. */
  private readonly slots = new Map<number, number>()
  /** The last value pushed per analog code, so a repeat is not an input. */
  private readonly lastAnalog = new Map<string, number>()
  private readonly listeners: Array<() => void> = []
  private enabled = false

  constructor(private readonly options: InputCaptureOptions) {
    this.bindings = bindingsFrom(options.manifest)
  }

  /** The device codes this game listens for, for a controls card. */
  get codes(): readonly string[] {
    return [...this.bindings.keys()]
  }

  attach(): void {
    if (this.enabled) return
    this.enabled = true
    const keyTarget = this.options.keyTarget ?? globalThis
    const onKeyDown = (event: Event): void => {
      const key = event as KeyboardEvent
      if (key.repeat) return
      this.press(key.code, 1)
    }
    const onKeyUp = (event: Event): void => {
      this.press((event as KeyboardEvent).code, 0)
    }
    keyTarget.addEventListener("keydown", onKeyDown)
    keyTarget.addEventListener("keyup", onKeyUp)
    this.listeners.push(() => {
      keyTarget.removeEventListener("keydown", onKeyDown)
      keyTarget.removeEventListener("keyup", onKeyUp)
    })

    const pointerTarget = this.options.pointerTarget
    const viewport = this.options.viewport
    if (pointerTarget !== undefined && viewport !== undefined) {
      const onPointer = (event: Event): void => {
        const pointer = event as PointerEvent
        const slot = this.slotFor(pointer.pointerId)
        const bounds = pointerTarget.getBoundingClientRect()
        // Quantised here, so the simulation never sees a CSS pixel.
        this.analog(
          `pointer${slot}-x`,
          quantisePoint(
            pointer.clientX - bounds.left,
            bounds.width,
            viewport.width,
          ),
        )
        this.analog(
          `pointer${slot}-y`,
          quantisePoint(
            pointer.clientY - bounds.top,
            bounds.height,
            viewport.height,
          ),
        )
        // The position goes in before the press, so a game hit-testing its
        // own controls knows where the finger landed in the same tick it
        // learns that it landed.
        if (pointer.type === "pointerdown") {
          this.press(`pointer${slot}`, 1)
        } else if (
          pointer.type === "pointerup" ||
          pointer.type === "pointercancel"
        ) {
          this.press(`pointer${slot}`, 0)
          this.freeSlot(pointer.pointerId, slot)
        }
      }
      // `pointercancel` is not optional. The browser sends it instead of
      // `pointerup` when it takes the pointer away - a scroll gesture wins,
      // the finger leaves the screen edge - and without it that slot stays
      // held and occupied for the rest of the session.
      for (const name of [
        "pointerdown",
        "pointerup",
        "pointercancel",
        "pointermove",
      ]) {
        pointerTarget.addEventListener(name, onPointer)
        this.listeners.push(() => {
          pointerTarget.removeEventListener(name, onPointer)
        })
      }
    }
  }

  /**
   * Which finger this is, as a small stable number.
   *
   * `PointerEvent.pointerId` is assigned by the browser and is neither small
   * nor comparable between runs, so it cannot appear in a device code. A slot
   * can: the lowest free index at `pointerdown`, freed at `pointerup`. One
   * finger is always slot 0, and the assignment is a pure function of the
   * order the events arrived in, which is the order the log records.
   *
   * Without this every touch shared one code. Two fingers interleaved into
   * one stream of coordinates, and the first to lift sent a release while the
   * other was still down - so a game drawing its own d-pad and a jump button
   * could not have both.
   */
  private slotFor(pointerId: number): number {
    const existing = this.slots.get(pointerId)
    if (existing !== undefined) return existing
    const taken = new Set(this.slots.values())
    let slot = 0
    while (taken.has(slot)) slot += 1
    this.slots.set(pointerId, slot)
    return slot
  }

  private freeSlot(pointerId: number, slot: number): void {
    this.slots.delete(pointerId)
    // The next finger into this slot reports where it is, rather than having
    // its first coordinate suppressed as unchanged from the last one's.
    this.lastAnalog.delete(`pointer${slot}-x`)
    this.lastAnalog.delete(`pointer${slot}-y`)
  }

  /** A press from a host-drawn on-screen control. The only virtual source. */
  virtual(action: string, value: number): void {
    this.options.queue.push({ device: "virtual", code: action, value })
  }

  /**
   * A value that is not a press: a coordinate, an axis.
   *
   * It goes through the manifest's binding table like a key does, so a game's
   * `tick` sees the action it named rather than `pointer0-x`, and a code the
   * game did not bind is dropped instead of filling the log. Repeats are
   * dropped too: `pointermove` fires far more often than a quantised
   * coordinate changes, and an unchanged value is not an input.
   */
  private analog(code: string, value: number): void {
    const binding = this.bindings.get(code)
    if (binding === undefined) return
    if (this.lastAnalog.get(code) === value) return
    this.lastAnalog.set(code, value)
    this.options.queue.push({
      device: binding.device,
      code: binding.action,
      value,
    })
  }

  private press(code: string, value: number): void {
    const binding = this.bindings.get(code)
    if (binding === undefined) return
    if (value === 1) {
      if (this.held.has(code)) return
      this.held.add(code)
    } else {
      if (!this.held.has(code)) return
      this.held.delete(code)
    }
    this.options.queue.push({
      device: binding.device,
      code: binding.action,
      value,
    })
  }

  /** Releases everything held, so a session that loses focus does not stick. */
  releaseAll(): void {
    for (const code of [...this.held]) this.press(code, 0)
    this.slots.clear()
    // Cleared rather than kept: after a focus loss the simulation should be
    // told where the pointer is when it comes back, not have it suppressed
    // as unchanged from before the gap.
    this.lastAnalog.clear()
  }

  detach(): void {
    this.releaseAll()
    for (const remove of this.listeners) remove()
    this.listeners.length = 0
    this.enabled = false
  }
}
