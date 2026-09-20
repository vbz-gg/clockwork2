import { describe, expect, test } from "bun:test"
import { LiveInputQueue, type Manifest } from "@clockwork2/kernel"
import { bindingsFrom, InputCapture } from "../src/input"

const MANIFEST = {
  inputs: {
    map: {
      left: [{ code: "ArrowLeft", device: "key" }],
      right: [
        { code: "ArrowRight", device: "key" },
        { code: "KeyD", device: "key" },
      ],
      thrust: [{ code: "Space", device: "key" }],
    },
  },
} as unknown as Manifest

/** A target a test drives by hand, so no DOM is needed. */
class FakeTarget implements EventTarget {
  private listeners = new Map<string, Set<EventListenerOrEventListenerObject>>()
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
    if (listener === null) return
    this.listeners.get(type)?.delete(listener)
  }
  dispatchEvent(): boolean {
    return true
  }
  send(type: string, event: Record<string, unknown>): void {
    for (const listener of this.listeners.get(type) ?? []) {
      ;(listener as (event: unknown) => void)(event)
    }
  }
  get count(): number {
    let total = 0
    for (const set of this.listeners.values()) total += set.size
    return total
  }
}

describe("input capture", () => {
  test("a manifest becomes a code to action lookup", () => {
    const bindings = bindingsFrom(MANIFEST)
    expect(bindings.get("ArrowLeft")?.action).toBe("left")
    expect(bindings.get("KeyD")?.action).toBe("right")
    expect(bindings.get("Escape")).toBeUndefined()
  })

  test("a bound key becomes an action, an unbound one is ignored", () => {
    const queue = new LiveInputQueue()
    const target = new FakeTarget()
    new InputCapture({ manifest: MANIFEST, queue, keyTarget: target }).attach()
    target.send("keydown", { code: "ArrowLeft", repeat: false })
    target.send("keydown", { code: "Escape", repeat: false })
    const taken = queue.take(10)
    expect(taken.map((e) => e.code)).toEqual(["left"])
    expect(taken[0]?.value).toBe(1)
  })

  test("an auto-repeat does not push again", () => {
    // A held key would otherwise put one input per repeat into the log, at a
    // rate that differs between operating systems.
    const queue = new LiveInputQueue()
    const target = new FakeTarget()
    new InputCapture({ manifest: MANIFEST, queue, keyTarget: target }).attach()
    target.send("keydown", { code: "Space", repeat: false })
    target.send("keydown", { code: "Space", repeat: true })
    target.send("keydown", { code: "Space", repeat: false })
    expect(queue.take(1).length).toBe(1)
  })

  test("a release is recorded once, and only if it was held", () => {
    const queue = new LiveInputQueue()
    const target = new FakeTarget()
    new InputCapture({ manifest: MANIFEST, queue, keyTarget: target }).attach()
    target.send("keyup", { code: "Space" })
    expect(queue.take(1).length).toBe(0)
    target.send("keydown", { code: "Space", repeat: false })
    target.send("keyup", { code: "Space" })
    target.send("keyup", { code: "Space" })
    expect(queue.take(2).map((e) => e.value)).toEqual([1, 0])
  })

  test("losing focus releases what was held", () => {
    // Otherwise a player who alt-tabs mid-thrust comes back still thrusting.
    const queue = new LiveInputQueue()
    const target = new FakeTarget()
    const capture = new InputCapture({
      manifest: MANIFEST,
      queue,
      keyTarget: target,
    })
    capture.attach()
    target.send("keydown", { code: "Space", repeat: false })
    target.send("keydown", { code: "ArrowLeft", repeat: false })
    queue.take(1)
    capture.releaseAll()
    expect(queue.take(2).map((e) => [e.code, e.value])).toEqual([
      ["thrust", 0],
      ["left", 0],
    ])
  })

  test("a virtual press names its action and says it is virtual", () => {
    const queue = new LiveInputQueue()
    const capture = new InputCapture({ manifest: MANIFEST, queue })
    capture.virtual("thrust", 1)
    const taken = queue.take(5)
    expect(taken[0]).toEqual({
      tick: 5,
      device: "virtual",
      code: "thrust",
      value: 1,
    })
  })

  test("detach removes every listener", () => {
    const queue = new LiveInputQueue()
    const target = new FakeTarget()
    const capture = new InputCapture({
      manifest: MANIFEST,
      queue,
      keyTarget: target,
    })
    capture.attach()
    expect(target.count).toBeGreaterThan(0)
    capture.detach()
    expect(target.count).toBe(0)
    target.send("keydown", { code: "Space", repeat: false })
    expect(queue.take(1).length).toBe(0)
  })
})
