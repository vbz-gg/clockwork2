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
} from "@clockwork2/kernel"

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
        const bounds = pointerTarget.getBoundingClientRect()
        // Quantised here, so the simulation never sees a CSS pixel.
        const x = quantisePoint(
          pointer.clientX - bounds.left,
          bounds.width,
          viewport.width,
        )
        const y = quantisePoint(
          pointer.clientY - bounds.top,
          bounds.height,
          viewport.height,
        )
        this.options.queue.push({
          device: "pointer",
          code: "pointer-x",
          value: x,
        })
        this.options.queue.push({
          device: "pointer",
          code: "pointer-y",
          value: y,
        })
        if (pointer.type === "pointerdown") {
          this.options.queue.push({
            device: "pointer",
            code: "pointer",
            value: 1,
          })
        } else if (pointer.type === "pointerup") {
          this.options.queue.push({
            device: "pointer",
            code: "pointer",
            value: 0,
          })
        }
      }
      for (const name of ["pointerdown", "pointerup", "pointermove"]) {
        pointerTarget.addEventListener(name, onPointer)
        this.listeners.push(() => {
          pointerTarget.removeEventListener(name, onPointer)
        })
      }
    }
  }

  /** A press from a host-drawn on-screen control. The only virtual source. */
  virtual(action: string, value: number): void {
    this.options.queue.push({ device: "virtual", code: action, value })
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
  }

  detach(): void {
    this.releaseAll()
    for (const remove of this.listeners) remove()
    this.listeners.length = 0
    this.enabled = false
  }
}
