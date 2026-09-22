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

/**
 * The pointer path.
 *
 * Pointer events arrive in CSS pixels, at whatever size the element happens to
 * be on this display. The simulation must never see that number: two players
 * on differently sized screens who touch the same spot have to produce the same
 * input, or the recording does not replay. So the host maps into the
 * simulation's own coordinate space and quantises before anything is queued.
 */
describe("pointer capture", () => {
  const VIEWPORT = { width: 320, height: 180 }

  /** An element of a known size and position, with no DOM behind it. */
  function element(
    rect: { left: number; top: number; width: number; height: number },
    target: FakeTarget,
  ): HTMLElement {
    return {
      addEventListener: target.addEventListener.bind(target),
      removeEventListener: target.removeEventListener.bind(target),
      getBoundingClientRect: () => rect,
    } as unknown as HTMLElement
  }

  function capture(options: { viewport?: typeof VIEWPORT } = {}) {
    const queue = new LiveInputQueue()
    const target = new FakeTarget()
    const rect = { left: 40, top: 20, width: 640, height: 360 }
    const capture = new InputCapture({
      manifest: MANIFEST,
      queue,
      keyTarget: new FakeTarget(),
      pointerTarget: element(rect, target),
      ...(options.viewport === undefined ? {} : { viewport: options.viewport }),
    })
    capture.attach()
    return { queue, target, capture }
  }

  test("a move is mapped into the simulation's space, not the element's", () => {
    // The element is twice the viewport's size and offset on the page. The
    // middle of it has to arrive as the middle of the viewport whatever either
    // of those happen to be.
    const { queue, target } = capture({ viewport: VIEWPORT })
    target.send("pointermove", {
      type: "pointermove",
      clientX: 360,
      clientY: 200,
    })
    const taken = queue.take(10)
    expect(taken.map((e) => [e.code, e.value])).toEqual([
      ["pointer-x", 160],
      ["pointer-y", 90],
    ])
  })

  test("both axes are pushed for every pointer event", () => {
    const { queue, target } = capture({ viewport: VIEWPORT })
    target.send("pointermove", {
      type: "pointermove",
      clientX: 40,
      clientY: 20,
    })
    expect(queue.take(10).map((e) => e.code)).toEqual([
      "pointer-x",
      "pointer-y",
    ])
  })

  test("a press adds a button input, a release adds its zero", () => {
    const { queue, target } = capture({ viewport: VIEWPORT })
    target.send("pointerdown", {
      type: "pointerdown",
      clientX: 360,
      clientY: 200,
    })
    target.send("pointerup", { type: "pointerup", clientX: 360, clientY: 200 })
    expect(queue.take(10).map((e) => [e.code, e.value])).toEqual([
      ["pointer-x", 160],
      ["pointer-y", 90],
      ["pointer", 1],
      ["pointer-x", 160],
      ["pointer-y", 90],
      ["pointer", 0],
    ])
  })

  test("every pointer input says it came from a pointer", () => {
    // The device is what tells a replay which quantisation produced the value.
    const { queue, target } = capture({ viewport: VIEWPORT })
    target.send("pointerdown", {
      type: "pointerdown",
      clientX: 100,
      clientY: 100,
    })
    expect(queue.take(10).every((e) => e.device === "pointer")).toBe(true)
  })

  test("detach removes the pointer listeners too", () => {
    const { queue, target, capture: c } = capture({ viewport: VIEWPORT })
    expect(target.count).toBe(3)
    c.detach()
    expect(target.count).toBe(0)
    target.send("pointermove", {
      type: "pointermove",
      clientX: 360,
      clientY: 200,
    })
    expect(queue.take(10).length).toBe(0)
  })

  /**
   * Without a viewport there is no space to map into, so listening at all would
   * mean queueing CSS pixels. Silence is the right answer, not a guess.
   */
  test("no viewport means no pointer listeners at all", () => {
    const { target } = capture()
    expect(target.count).toBe(0)
  })

  test("no pointer target means no pointer listeners either", () => {
    const queue = new LiveInputQueue()
    const keys = new FakeTarget()
    new InputCapture({
      manifest: MANIFEST,
      queue,
      keyTarget: keys,
      viewport: VIEWPORT,
    }).attach()
    // The two key listeners, and nothing else.
    expect(keys.count).toBe(2)
  })
})

describe("attaching more than once", () => {
  /**
   * A host that attaches twice would otherwise register every listener twice
   * and push every press twice, which reads in the log as a player who cannot
   * stop double-tapping and replays to a different result.
   */
  test("is ignored, rather than doubling every listener", () => {
    const queue = new LiveInputQueue()
    const target = new FakeTarget()
    const capture = new InputCapture({
      manifest: MANIFEST,
      queue,
      keyTarget: target,
    })
    capture.attach()
    capture.attach()
    capture.attach()
    expect(target.count).toBe(2)
    target.send("keydown", { code: "Space", repeat: false })
    expect(queue.take(5).length).toBe(1)
  })

  test("and attach works again after a detach", () => {
    const queue = new LiveInputQueue()
    const target = new FakeTarget()
    const capture = new InputCapture({
      manifest: MANIFEST,
      queue,
      keyTarget: target,
    })
    capture.attach()
    capture.detach()
    capture.attach()
    target.send("keydown", { code: "Space", repeat: false })
    expect(queue.take(5).map((e) => e.code)).toEqual(["thrust"])
  })
})

describe("codes", () => {
  test("lists every bound device code, for a controls card", () => {
    // A card built from this is what tells a player which keys do anything.
    const capture = new InputCapture({
      manifest: MANIFEST,
      queue: new LiveInputQueue(),
    })
    expect(capture.codes).toEqual(["ArrowLeft", "ArrowRight", "KeyD", "Space"])
  })
})
