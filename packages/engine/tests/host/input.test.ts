import { describe, expect, test } from "bun:test"
import { LiveInputQueue, type Manifest } from "../../src"
import {
  bindingsFrom,
  type CaptureEnvironment,
  DEVICE_NOTICES,
  type DeviceNotice,
  InputCapture,
  type InputCaptureOptions,
  type MotionReading,
} from "../../src/host/input"
import { POINTER_SLOTS } from "../../src/input-codes"

/** A target a test drives by hand, so no DOM is needed. */
class FakeTarget implements EventTarget {
  private listeners = new Map<string, Set<EventListenerOrEventListenerObject>>()
  readonly options = new Map<string, unknown>()
  addEventListener(
    type: string,
    listener: EventListenerOrEventListenerObject | null,
    options?: unknown,
  ): void {
    if (listener === null) return
    const set = this.listeners.get(type) ?? new Set()
    set.add(listener)
    this.listeners.set(type, set)
    this.options.set(type, options)
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
  send(type: string, event: Record<string, unknown> = {}): void {
    for (const listener of this.listeners.get(type) ?? []) {
      ;(listener as (event: unknown) => void)({ type, ...event })
    }
  }
  get count(): number {
    let total = 0
    for (const set of this.listeners.values()) total += set.size
    return total
  }
}

/** The browser around a capture, every part of it a fake. */
function fakeEnvironment() {
  const window = new FakeTarget()
  const document = Object.assign(new FakeTarget(), {
    visibilityState: "visible",
    pointerLockElement: null as unknown,
  })
  let pads: readonly (Gamepad | null)[] = []
  let blocked: Error | null = null
  const environment: CaptureEnvironment = {
    window,
    document: document as unknown as CaptureEnvironment["document"],
    gamepads: () => {
      if (blocked !== null) throw blocked
      return pads
    },
  }
  return {
    window,
    document,
    environment,
    setPads(next: readonly (Gamepad | null)[]) {
      pads = next
    },
    block(error: Error) {
      blocked = error
    },
  }
}

/** An element of a known size and position, with no DOM behind it. */
function fakeElement(rect = { left: 40, top: 20, width: 640, height: 360 }) {
  const target = new FakeTarget()
  const captured: number[] = []
  let lock: () => unknown = () => undefined
  const element = {
    addEventListener: target.addEventListener.bind(target),
    removeEventListener: target.removeEventListener.bind(target),
    getBoundingClientRect: () => rect,
    style: { touchAction: "pan-y" },
    setPointerCapture: (id: number) => {
      captured.push(id)
    },
    requestPointerLock: () => lock(),
  }
  return {
    target,
    captured,
    element,
    html: element as unknown as HTMLElement,
    onLock(next: () => unknown) {
      lock = next
    },
  }
}

function manifest(
  map: Record<string, readonly { code: string }[]>,
  extra: Partial<Manifest["inputs"]> = {},
): Manifest {
  return {
    inputs: { map, viewport: { width: 320, height: 180 }, ...extra },
  } as unknown as Manifest
}

const KEYS = manifest({
  left: [{ code: "ArrowLeft" }],
  right: [{ code: "ArrowRight" }, { code: "KeyD" }],
  thrust: [{ code: "Space" }],
})

function keyCapture() {
  const queue = new LiveInputQueue()
  const keys = new FakeTarget()
  const browser = fakeEnvironment()
  const capture = new InputCapture({
    manifest: KEYS,
    queue,
    keyTarget: keys,
    environment: browser.environment,
  })
  capture.attach()
  return { queue, keys, capture, browser }
}

const taken = (queue: LiveInputQueue, tick = 0) =>
  queue.take(tick).map((e) => [e.device, e.code, e.value])

describe("keys", () => {
  test("a manifest becomes a code to action lookup, and an unknown code is left out", () => {
    const bindings = bindingsFrom(
      manifest({ go: [{ code: "KeyD" }, { code: "pointer0-z" }] }),
    )
    expect(bindings.get("KeyD")?.action).toBe("go")
    expect(bindings.get("KeyD")?.device).toBe("key")
    expect(bindings.has("pointer0-z")).toBe(false)
  })

  test("a bound key becomes an action, an unbound one is ignored", () => {
    const { queue, keys } = keyCapture()
    keys.send("keydown", { code: "ArrowLeft", repeat: false })
    keys.send("keydown", { code: "Escape", repeat: false })
    expect(taken(queue)).toEqual([["key", "left", 1]])
  })

  test("an auto-repeat does not push again", () => {
    // A held key would otherwise put one input per repeat into the log, at a
    // rate that differs between operating systems.
    const { queue, keys } = keyCapture()
    keys.send("keydown", { code: "Space", repeat: false })
    keys.send("keydown", { code: "Space", repeat: true })
    keys.send("keydown", { code: "Space", repeat: false })
    expect(queue.take(1).length).toBe(1)
  })

  test("a release is recorded once, and only if it was held", () => {
    const { queue, keys } = keyCapture()
    keys.send("keyup", { code: "Space" })
    expect(queue.take(1).length).toBe(0)
    keys.send("keydown", { code: "Space", repeat: false })
    keys.send("keyup", { code: "Space" })
    keys.send("keyup", { code: "Space" })
    expect(queue.take(2).map((e) => e.value)).toEqual([1, 0])
  })

  test("the frame losing focus releases what was held", () => {
    // A key held while the player clicks the page around the game sends its
    // keyup to that page, so the frame would hold it for the rest of the run.
    const { queue, keys, browser } = keyCapture()
    keys.send("keydown", { code: "Space", repeat: false })
    keys.send("keydown", { code: "ArrowLeft", repeat: false })
    queue.take(1)
    browser.window.send("blur")
    expect(taken(queue, 2)).toEqual([
      ["key", "thrust", 0],
      ["key", "left", 0],
    ])
  })

  test("a hidden tab releases what was held, and a visible one does not", () => {
    const { queue, keys, browser } = keyCapture()
    keys.send("keydown", { code: "Space", repeat: false })
    queue.take(1)
    browser.document.visibilityState = "visible"
    browser.document.send("visibilitychange")
    expect(queue.take(2)).toEqual([])
    browser.document.visibilityState = "hidden"
    browser.document.send("visibilitychange")
    expect(taken(queue, 3)).toEqual([["key", "thrust", 0]])
  })

  test("detach removes every listener", () => {
    const { queue, keys, capture, browser } = keyCapture()
    expect(keys.count).toBeGreaterThan(0)
    capture.detach()
    expect(keys.count).toBe(0)
    expect(browser.window.count).toBe(0)
    expect(browser.document.count).toBe(0)
    keys.send("keydown", { code: "Space", repeat: false })
    expect(queue.take(1).length).toBe(0)
  })

  test("attaching twice is ignored, and attach works again after a detach", () => {
    const { queue, keys, capture } = keyCapture()
    const listening = keys.count
    capture.attach()
    expect(keys.count).toBe(listening)
    capture.detach()
    capture.attach()
    keys.send("keydown", { code: "Space", repeat: false })
    expect(queue.take(1).length).toBe(1)
  })

  test("codes lists every bound device code, for a controls card", () => {
    const { capture } = keyCapture()
    expect([...capture.codes].sort()).toEqual([
      "ArrowLeft",
      "ArrowRight",
      "KeyD",
      "Space",
    ])
  })
})

describe("a capture that could not work is refused when it is made", () => {
  const queue = new LiveInputQueue()
  const refuse = (options: Partial<InputCaptureOptions>, why: RegExp) => {
    expect(
      () => new InputCapture({ manifest: KEYS, queue, ...options }),
    ).toThrow(why)
  }

  test("a pointer code with nowhere to listen", () => {
    // Otherwise the game builds, passes conformance and cannot be touched.
    refuse(
      { manifest: manifest({ tap: [{ code: "pointer0" }] }) },
      /E_ARG_INVALID.*pointerTarget/,
    )
  })

  test("a pointer position with no viewport to measure it in", () => {
    refuse(
      {
        manifest: {
          inputs: { map: { aim: [{ code: "pointer0-x" }] } },
        } as unknown as Manifest,
        pointerTarget: fakeElement().html,
      },
      /E_ARG_INVALID.*viewport/,
    )
  })

  test("a tilt code with no motion source", () => {
    refuse(
      { manifest: manifest({ lean: [{ code: "tilt-x" }] }) },
      /E_ARG_INVALID.*motion/,
    )
  })

  test("a gamepad or mouse movement with nowhere to report a blocked device", () => {
    refuse(
      { manifest: manifest({ jump: [{ code: "gamepad0-button0" }] }) },
      /E_ARG_INVALID.*onNotice/,
    )
    refuse(
      {
        manifest: manifest({ look: [{ code: "mouse-dx" }] }),
        pointerTarget: fakeElement().html,
      },
      /E_ARG_INVALID.*onNotice/,
    )
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
describe("pointers", () => {
  const POINTERS = manifest({
    aimX: [{ code: "pointer0-x" }],
    aimY: [{ code: "pointer0-y" }],
    touch: [{ code: "pointer0" }],
    aim2X: [{ code: "pointer1-x" }],
    touch2: [{ code: "pointer1" }],
    main: [{ code: "pointer0-button0" }],
    alt: [{ code: "pointer0-button2" }],
    hoverX: [{ code: "hover-x" }],
  })

  function pointerCapture(map: Manifest = POINTERS) {
    const queue = new LiveInputQueue()
    const element = fakeElement()
    const browser = fakeEnvironment()
    const notices: DeviceNotice[] = []
    const capture = new InputCapture({
      manifest: map,
      queue,
      keyTarget: new FakeTarget(),
      pointerTarget: element.html,
      onNotice: (notice) => notices.push(notice),
      environment: browser.environment,
    })
    capture.attach()
    return { queue, element, browser, capture, notices }
  }

  // The element is 640 by 360 at (40, 20), twice the viewport's size.
  const at = (x: number, y: number) => ({
    clientX: 40 + x * 2,
    clientY: 20 + y * 2,
  })

  test("a press is mapped into the simulation's space, position before press", () => {
    // A game hit-testing its own controls has to know where the finger
    // landed in the same tick it learns that it landed.
    const { queue, element } = pointerCapture()
    element.target.send("pointerdown", {
      pointerId: 7,
      pointerType: "touch",
      buttons: 1,
      ...at(160, 90),
    })
    expect(taken(queue)).toEqual([
      ["pointer", "aimX", 160],
      ["pointer", "aimY", 90],
      ["pointer", "touch", 1],
      ["pointer", "main", 1],
    ])
  })

  test("a press is captured, so its release arrives wherever the pointer goes", () => {
    // A mouse is not captured on its own the way a finger is. Pressed in the
    // game and released over the page around it, it would never come up.
    const { element } = pointerCapture()
    element.target.send("pointerdown", {
      pointerId: 3,
      buttons: 1,
      ...at(1, 1),
    })
    expect(element.captured).toEqual([3])
  })

  test("touch-action is set on the element, and given back on detach", () => {
    // It does not cascade into a frame from the page around it, and without
    // it a moving finger becomes a pan and its control lets go mid-press.
    const { element, capture } = pointerCapture()
    expect(element.element.style.touchAction).toBe("none")
    capture.detach()
    expect(element.element.style.touchAction).toBe("pan-y")
  })

  test("two fingers are told apart, and one lifting does not release the other", () => {
    const { queue, element } = pointerCapture()
    element.target.send("pointerdown", {
      pointerId: 11,
      buttons: 1,
      ...at(10, 10),
    })
    element.target.send("pointerdown", {
      pointerId: 12,
      buttons: 1,
      ...at(20, 10),
    })
    queue.take(0)
    element.target.send("pointerup", {
      pointerId: 11,
      buttons: 0,
      ...at(10, 10),
    })
    expect(taken(queue, 1)).toEqual([
      ["pointer", "main", 0],
      ["pointer", "touch", 0],
    ])
    element.target.send("pointermove", {
      pointerId: 12,
      buttons: 1,
      ...at(30, 10),
    })
    expect(taken(queue, 2)).toEqual([["pointer", "aim2X", 30]])
  })

  test("a lifted finger's slot is reused by the next one", () => {
    const { queue, element } = pointerCapture()
    element.target.send("pointerdown", {
      pointerId: 1,
      buttons: 1,
      ...at(5, 5),
    })
    element.target.send("pointerup", { pointerId: 1, buttons: 0, ...at(5, 5) })
    queue.take(0)
    element.target.send("pointerdown", {
      pointerId: 2,
      buttons: 1,
      ...at(6, 6),
    })
    expect(taken(queue, 1)).toContainEqual(["pointer", "touch", 1])
  })

  test("the capture lost after a release takes no slot, so the next finger is still slot 0", () => {
    // Every pointerup is followed by lostpointercapture for the same id. If
    // that took a fresh slot, slot 0 would stay taken after the first tap and
    // a game binding pointer0 would stop seeing touches.
    const { queue, element } = pointerCapture()
    element.target.send("pointerdown", {
      pointerId: 1,
      buttons: 1,
      ...at(5, 5),
    })
    element.target.send("pointerup", { pointerId: 1, buttons: 0, ...at(5, 5) })
    element.target.send("lostpointercapture", { pointerId: 1, ...at(5, 5) })
    queue.take(0)
    element.target.send("pointerdown", {
      pointerId: 2,
      buttons: 1,
      ...at(6, 6),
    })
    expect(taken(queue, 1)).toEqual([
      ["pointer", "aimX", 6],
      ["pointer", "aimY", 6],
      ["pointer", "touch", 1],
      ["pointer", "main", 1],
    ])
  })

  test("a capture lost while held is a release", () => {
    const { queue, element } = pointerCapture()
    element.target.send("pointerdown", {
      pointerId: 4,
      buttons: 1,
      ...at(5, 5),
    })
    queue.take(0)
    element.target.send("lostpointercapture", { pointerId: 4, ...at(99, 99) })
    // No position: the pointer is gone, and where it went is not the game's.
    expect(taken(queue, 1)).toEqual([
      ["pointer", "main", 0],
      ["pointer", "touch", 0],
    ])
  })

  test("a cancelled pointer releases and frees its slot", () => {
    const { queue, element } = pointerCapture()
    element.target.send("pointerdown", {
      pointerId: 9,
      buttons: 1,
      ...at(5, 5),
    })
    element.target.send("pointercancel", { pointerId: 9, ...at(0, 0) })
    expect(taken(queue).slice(-2)).toEqual([
      ["pointer", "main", 0],
      ["pointer", "touch", 0],
    ])
    element.target.send("pointerdown", {
      pointerId: 10,
      buttons: 1,
      ...at(5, 5),
    })
    expect(taken(queue, 1)).toContainEqual(["pointer", "touch", 1])
  })

  test("a resting mouse takes no slot, so a touch beside it is still slot 0", () => {
    // On a touch laptop the mouse moves over the game first. Taking a slot
    // on a move would make every finger slot 1.
    const { queue, element } = pointerCapture()
    element.target.send("pointermove", {
      pointerId: 1,
      pointerType: "mouse",
      buttons: 0,
      ...at(50, 50),
    })
    expect(taken(queue)).toEqual([["pointer", "hoverX", 50]])
    element.target.send("pointerdown", {
      pointerId: 2,
      pointerType: "touch",
      buttons: 1,
      ...at(60, 60),
    })
    expect(taken(queue, 1)).toContainEqual(["pointer", "touch", 1])
  })

  test("a finger cannot hover", () => {
    const { queue, element } = pointerCapture()
    element.target.send("pointermove", {
      pointerId: 1,
      pointerType: "touch",
      buttons: 0,
      ...at(50, 50),
    })
    expect(queue.take(0)).toEqual([])
  })

  test("a move that does not change the quantised value pushes nothing", () => {
    const { queue, element } = pointerCapture()
    element.target.send("pointerdown", {
      pointerId: 1,
      buttons: 1,
      ...at(5, 5),
    })
    queue.take(0)
    element.target.send("pointermove", {
      pointerId: 1,
      buttons: 1,
      clientX: 50.4,
      clientY: 30.4,
    })
    expect(queue.take(1)).toEqual([])
  })

  test("a finger the game did not bind a slot for is dropped", () => {
    const { queue, element } = pointerCapture()
    for (const id of [1, 2, 3]) {
      element.target.send("pointerdown", {
        pointerId: id,
        buttons: 1,
        ...at(id, id),
      })
    }
    const pressed = queue
      .take(0)
      .filter((e) => e.value === 1 && e.code.startsWith("touch"))
      .map((e) => e.code)
    expect(pressed).toEqual(["touch", "touch2"])
  })

  test(`a finger past the ${POINTER_SLOTS} slots is dropped`, () => {
    const map = manifest({
      last: [{ code: `pointer${POINTER_SLOTS - 1}` }],
    })
    const { queue, element } = pointerCapture(map)
    for (let id = 0; id <= POINTER_SLOTS; id++) {
      element.target.send("pointerdown", {
        pointerId: id,
        buttons: 1,
        ...at(1, 1),
      })
    }
    expect(taken(queue)).toEqual([["pointer", "last", 1]])
    expect(element.captured.length).toBe(POINTER_SLOTS)
  })

  test("a second mouse button is heard from a move, as browsers send it", () => {
    // A button pressed while another is held fires no pointerdown, only a
    // move with different buttons.
    const { queue, element } = pointerCapture()
    element.target.send("pointerdown", {
      pointerId: 1,
      buttons: 1,
      ...at(5, 5),
    })
    queue.take(0)
    element.target.send("pointermove", {
      pointerId: 1,
      buttons: 3,
      ...at(5, 5),
    })
    expect(taken(queue, 1)).toEqual([["pointer", "alt", 1]])
    element.target.send("pointermove", {
      pointerId: 1,
      buttons: 1,
      ...at(5, 5),
    })
    expect(taken(queue, 2)).toEqual([["pointer", "alt", 0]])
    element.target.send("pointerup", { pointerId: 1, buttons: 0, ...at(5, 5) })
    expect(taken(queue, 3)).toEqual([
      ["pointer", "main", 0],
      ["pointer", "touch", 0],
    ])
  })

  test("a right press alone is a press of the pointer and of button 2", () => {
    const { queue, element } = pointerCapture()
    element.target.send("pointerdown", {
      pointerId: 1,
      buttons: 2,
      ...at(5, 5),
    })
    expect(taken(queue).slice(2)).toEqual([
      ["pointer", "touch", 1],
      ["pointer", "alt", 1],
    ])
  })

  test("the right-click menu stays shut only when the game binds the right button", () => {
    const prevented: string[] = []
    const menu = { preventDefault: () => prevented.push("menu") }
    const bound = pointerCapture()
    bound.element.target.send("contextmenu", menu)
    expect(prevented).toEqual(["menu"])
    const unbound = pointerCapture(manifest({ touch: [{ code: "pointer0" }] }))
    unbound.element.target.send("contextmenu", menu)
    expect(prevented).toEqual(["menu"])
  })

  test("releasing everything frees every pointer's slot", () => {
    const { queue, element, browser } = pointerCapture()
    element.target.send("pointerdown", {
      pointerId: 1,
      buttons: 1,
      ...at(5, 5),
    })
    queue.take(0)
    browser.window.send("blur")
    expect(taken(queue, 1)).toEqual([
      ["pointer", "main", 0],
      ["pointer", "touch", 0],
    ])
    // The finger still on the glass is a stranger now: its next move is not
    // a press, and its release releases nothing.
    element.target.send("pointerup", { pointerId: 1, buttons: 0, ...at(5, 5) })
    expect(queue.take(2)).toEqual([])
  })
})

describe("the mouse locked to the game", () => {
  const LOOK = manifest({
    lookX: [{ code: "mouse-dx" }],
    lookY: [{ code: "mouse-dy" }],
    fire: [{ code: "pointer0" }],
    aimX: [{ code: "pointer0-x" }],
  })

  function lockCapture() {
    const queue = new LiveInputQueue()
    const element = fakeElement()
    const browser = fakeEnvironment()
    const notices: DeviceNotice[] = []
    const capture = new InputCapture({
      manifest: LOOK,
      queue,
      pointerTarget: element.html,
      onNotice: (notice) => notices.push(notice),
      environment: browser.environment,
    })
    capture.attach()
    return { queue, element, browser, notices }
  }

  test("a press asks for the lock", () => {
    const { element } = lockCapture()
    let asked = 0
    element.onLock(() => {
      asked++
    })
    element.target.send("pointerdown", {
      pointerId: 1,
      buttons: 1,
      clientX: 50,
      clientY: 30,
    })
    expect(asked).toBe(1)
  })

  test("while locked, movement is recorded in whole pixels added up per tick, and positions are not", () => {
    const { queue, element, browser } = lockCapture()
    browser.document.pointerLockElement = element.element
    for (const movementX of [1.5, 2.25, -0.5]) {
      element.target.send("pointermove", {
        pointerId: 1,
        buttons: 0,
        clientX: 50,
        clientY: 30,
        movementX,
        movementY: 4,
      })
    }
    // 1.5 + 2.25 - 0.5 = 3.25: three whole pixels, a quarter carried.
    expect(taken(queue)).toEqual([
      ["pointer", "lookX", 3],
      ["pointer", "lookY", 12],
    ])
    element.target.send("pointermove", {
      pointerId: 1,
      buttons: 0,
      clientX: 50,
      clientY: 30,
      movementX: 0.75,
      movementY: 0,
    })
    expect(taken(queue, 1)).toEqual([["pointer", "lookX", 1]])
  })

  test("a refused lock is reported, whether the browser rejects or throws", async () => {
    const { element, notices } = lockCapture()
    element.onLock(() => Promise.reject(new Error("no gesture")))
    element.target.send("pointerdown", {
      pointerId: 1,
      buttons: 1,
      clientX: 50,
      clientY: 30,
    })
    element.target.send("pointerup", {
      pointerId: 1,
      buttons: 0,
      clientX: 50,
      clientY: 30,
    })
    await Promise.resolve()
    element.onLock(() => {
      throw new Error("not allowed")
    })
    element.target.send("pointerdown", {
      pointerId: 2,
      buttons: 1,
      clientX: 50,
      clientY: 30,
    })
    expect(notices.map((n) => n.code)).toEqual([
      DEVICE_NOTICES.POINTER_LOCK_REFUSED,
      DEVICE_NOTICES.POINTER_LOCK_REFUSED,
    ])
  })

  test("leaving the lock releases everything", () => {
    const { queue, element, browser } = lockCapture()
    browser.document.pointerLockElement = element.element
    element.target.send("pointerdown", {
      pointerId: 1,
      buttons: 1,
      clientX: 50,
      clientY: 30,
    })
    queue.take(0)
    browser.document.pointerLockElement = null
    browser.document.send("pointerlockchange")
    expect(taken(queue, 1)).toEqual([["pointer", "fire", 0]])
  })
})

describe("the wheel", () => {
  const ZOOM = manifest({ zoom: [{ code: "wheel-y" }] })

  function wheelCapture() {
    const queue = new LiveInputQueue()
    const browser = fakeEnvironment()
    new InputCapture({
      manifest: ZOOM,
      queue,
      environment: browser.environment,
    }).attach()
    return { queue, browser }
  }

  const wheel = (deltaMode: number, deltaY: number, deltaX = 0) => ({
    deltaMode,
    deltaX,
    deltaY,
    preventDefault: () => undefined,
  })

  test("pixels become whole notches, added up per tick, the fraction carried", () => {
    const { queue, browser } = wheelCapture()
    browser.window.send("wheel", wheel(0, 250))
    browser.window.send("wheel", wheel(0, 30))
    expect(taken(queue)).toEqual([["wheel", "zoom", 2]])
    // 80 pixels were carried; 20 more make the third notch.
    browser.window.send("wheel", wheel(0, 20))
    expect(taken(queue, 1)).toEqual([["wheel", "zoom", 1]])
  })

  test("lines are three to a notch, and a page is one", () => {
    const { queue, browser } = wheelCapture()
    browser.window.send("wheel", wheel(1, -3))
    expect(taken(queue)).toEqual([["wheel", "zoom", -1]])
    browser.window.send("wheel", wheel(2, 2))
    expect(taken(queue, 1)).toEqual([["wheel", "zoom", 2]])
  })

  test("the mode is read before any delta", () => {
    // Firefox reports lines only to a listener that asks for the mode first,
    // and quietly converts to pixels otherwise.
    const { browser } = wheelCapture()
    const reads: string[] = []
    browser.window.send("wheel", {
      get deltaMode() {
        reads.push("deltaMode")
        return 1
      },
      get deltaX() {
        reads.push("deltaX")
        return 0
      },
      get deltaY() {
        reads.push("deltaY")
        return 3
      },
      preventDefault: () => undefined,
    })
    expect(reads[0]).toBe("deltaMode")
  })

  test("the listener is not passive, so the page behind does not scroll", () => {
    const { browser } = wheelCapture()
    expect(browser.window.options.get("wheel")).toEqual({ passive: false })
    let prevented = false
    browser.window.send("wheel", {
      ...wheel(0, 100),
      preventDefault: () => {
        prevented = true
      },
    })
    expect(prevented).toBe(true)
  })

  test("an unknown mode and an unbound axis record nothing", () => {
    const { queue, browser } = wheelCapture()
    browser.window.send("wheel", wheel(7, 300))
    browser.window.send("wheel", wheel(0, 0, 500))
    expect(queue.take(0)).toEqual([])
  })
})

describe("gamepads", () => {
  const PAD = manifest({
    jump: [{ code: "gamepad0-button0" }],
    brake: [{ code: "gamepad0-button6-value" }],
    steer: [{ code: "gamepad0-axis0" }],
    jump2: [{ code: "gamepad1-button0" }],
  })

  function pad(
    index: number,
    buttons: readonly [boolean, number][],
    axes: readonly number[],
    mapping = "standard",
    id = "pad",
  ): Gamepad {
    return {
      index,
      id,
      mapping,
      connected: true,
      buttons: buttons.map(([pressed, value]) => ({
        pressed,
        value,
        touched: pressed,
      })),
      axes,
    } as unknown as Gamepad
  }

  function padCapture() {
    const queue = new LiveInputQueue()
    const browser = fakeEnvironment()
    const notices: DeviceNotice[] = []
    const capture = new InputCapture({
      manifest: PAD,
      queue,
      onNotice: (notice) => notices.push(notice),
      environment: browser.environment,
    })
    capture.attach()
    return { queue, browser, notices, capture }
  }

  const SEVEN: [boolean, number][] = Array.from({ length: 7 }, () => [false, 0])

  test("a poll reads presses, trigger travel and sticks, each once until it changes", () => {
    const { queue, browser } = padCapture()
    const buttons: [boolean, number][] = [...SEVEN]
    buttons[0] = [true, 1]
    buttons[6] = [false, 0.5]
    browser.setPads([pad(0, buttons, [0.5, 0])])
    queue.poll()
    expect(taken(queue)).toEqual([
      ["gamepad", "jump", 1],
      ["gamepad", "brake", 50],
      ["gamepad", "steer", 46],
    ])
    queue.poll()
    expect(queue.take(1)).toEqual([])
  })

  test("polls between ticks leave a stick's last value only", () => {
    const { queue, browser } = padCapture()
    for (const x of [0.3, 0.6, 1]) {
      browser.setPads([pad(0, SEVEN, [x])])
      queue.poll()
    }
    expect(taken(queue)).toEqual([["gamepad", "steer", 100]])
  })

  test("an unplugged controller lets go of its buttons and centres its sticks", () => {
    const { queue, browser } = padCapture()
    const buttons: [boolean, number][] = [...SEVEN]
    buttons[0] = [true, 1]
    browser.setPads([pad(0, buttons, [-1])])
    queue.poll()
    queue.take(0)
    browser.setPads([null])
    queue.poll()
    // The trigger was never pressed, so it has nothing to let go of.
    expect(taken(queue, 1)).toEqual([
      ["gamepad", "jump", 0],
      ["gamepad", "steer", 0],
    ])
  })

  test("releasing everything centres the sticks, and a button still down is pressed again", () => {
    const { queue, browser } = padCapture()
    const buttons: [boolean, number][] = [...SEVEN]
    buttons[0] = [true, 1]
    browser.setPads([pad(0, buttons, [1])])
    queue.poll()
    queue.take(0)
    browser.window.send("blur")
    expect(taken(queue, 1)).toEqual([
      ["gamepad", "jump", 0],
      ["gamepad", "steer", 0],
    ])
    queue.poll()
    expect(taken(queue, 2)).toEqual([
      ["gamepad", "jump", 1],
      ["gamepad", "steer", 100],
    ])
  })

  test("a page that forbids gamepads is reported once, and nothing is read after", () => {
    const { queue, browser, notices } = padCapture()
    browser.block(new Error("SecurityError"))
    queue.poll()
    queue.poll()
    expect(notices.map((n) => n.code)).toEqual([DEVICE_NOTICES.GAMEPAD_BLOCKED])
    expect(queue.take(0)).toEqual([])
  })

  test("a controller with no standard layout is reported once, and still recorded", () => {
    const { queue, browser, notices } = padCapture()
    const buttons: [boolean, number][] = [...SEVEN]
    buttons[0] = [true, 1]
    browser.setPads([pad(1, buttons, [], "", "odd stick")])
    queue.poll()
    queue.poll()
    expect(notices).toEqual([
      {
        code: DEVICE_NOTICES.GAMEPAD_UNMAPPED,
        detail: "gamepad 1 (odd stick) has no standard layout",
      },
    ])
    expect(taken(queue)).toEqual([["gamepad", "jump2", 1]])
  })

  test("a controller past the fourth is ignored", () => {
    const { queue, browser } = padCapture()
    browser.setPads([pad(4, [[true, 1]], [1])])
    queue.poll()
    expect(queue.take(0)).toEqual([])
  })

  test("detach stops the polling", () => {
    const { queue, browser, capture } = padCapture()
    capture.detach()
    browser.setPads([pad(0, [[true, 1]], [])])
    queue.poll()
    expect(queue.take(0)).toEqual([])
  })
})

describe("tilt", () => {
  const TILT = manifest({
    lean: [{ code: "tilt-x" }],
    pitch: [{ code: "tilt-y" }],
    face: [{ code: "tilt-z" }],
  })

  function tiltCapture() {
    const queue = new LiveInputQueue()
    const listeners = new Set<(reading: MotionReading) => void>()
    const capture = new InputCapture({
      manifest: TILT,
      queue,
      motion: {
        onMotion: (listener) => {
          listeners.add(listener)
          return () => listeners.delete(listener)
        },
      },
      environment: fakeEnvironment().environment,
    })
    capture.attach()
    const read = (beta: number, gamma: number, angle: number = 0) => {
      for (const listener of listeners) {
        listener({ beta, gamma, angle } as MotionReading)
      }
    }
    return { queue, read, capture, listeners }
  }

  test("flat on a table, face up, gravity points into the table", () => {
    const { queue, read } = tiltCapture()
    read(0, 0)
    expect(taken(queue)).toEqual([
      ["motion", "lean", 0],
      ["motion", "pitch", 0],
      ["motion", "face", -100],
    ])
  })

  test("the right edge tipped down 30 degrees reads half of gravity to the right", () => {
    const { queue, read } = tiltCapture()
    read(0, 30)
    expect(taken(queue)).toContainEqual(["motion", "lean", 50])
  })

  test("held upright, gravity points down the screen", () => {
    const { queue, read } = tiltCapture()
    read(90, 0)
    expect(taken(queue)).toContainEqual(["motion", "pitch", -100])
  })

  test("the axes turn with the screen", () => {
    // Upright, then turned a quarter so the screen is landscape: down the
    // device is now across the screen.
    const { queue, read } = tiltCapture()
    read(90, 0, 90)
    const values = new Map(queue.take(0).map((e) => [e.code, e.value]))
    expect(values.get("lean")).toBe(100)
    expect(values.get("pitch")).toBe(0)
  })

  test("a reading inside the deadband records nothing", () => {
    // A hand-held phone resting near a unit boundary would otherwise record
    // an input on every reading.
    const { queue, read } = tiltCapture()
    read(0, 0)
    queue.take(0)
    read(0, 0.4)
    expect(queue.take(1)).toEqual([])
    read(0, 2)
    expect(taken(queue, 2)).toEqual([["motion", "lean", 3]])
  })

  test("a malformed reading is dropped, never recorded as lying flat", () => {
    const { queue, read } = tiltCapture()
    for (const [beta, gamma, angle] of [
      [Number.NaN, 0, 0],
      [null as unknown as number, 0, 0],
      [200, 0, 0],
      [0, 95, 0],
      [0, 0, 45],
    ] as const) {
      read(beta, gamma, angle)
    }
    expect(queue.take(0)).toEqual([])
  })

  test("detach stops listening", () => {
    const { capture, listeners } = tiltCapture()
    expect(listeners.size).toBe(1)
    capture.detach()
    expect(listeners.size).toBe(0)
  })
})
