import { describe, expect, test } from "bun:test"
import { LiveInputQueue, type Manifest } from "../../src"
import {
  type CaptureEnvironment,
  type CaptureMapping,
  checkCapture,
  DEVICE_NOTICES,
  type DeviceNotice,
  InputCapture,
  POINTER_SLOTS,
  screenRotation,
} from "../../src/host/input"
import type { Inputs } from "../../src/manifest/types"

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
      ;(listener as (event: unknown) => void)({
        type,
        preventDefault: () => undefined,
        ...event,
      })
    }
  }
  get count(): number {
    let total = 0
    for (const set of this.listeners.values()) total += set.size
    return total
  }
}

/** The browser around a capture, every part of it a fake. */
function fakeBrowser() {
  const window = new FakeTarget()
  const document = Object.assign(new FakeTarget(), {
    visibilityState: "visible",
    pointerLockElement: null as unknown,
  })
  let pads: readonly (Gamepad | null)[] = []
  let blocked: Error | null = null
  let angle: number | undefined = 0
  const environment: CaptureEnvironment = {
    window,
    document: document as unknown as CaptureEnvironment["document"],
    gamepads: () => {
      if (blocked !== null) throw blocked
      return pads
    },
    screenAngle: () => angle,
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
    turn(next: number | undefined) {
      angle = next
    },
  }
}

/** An element 640 by 360 at (40, 20), with no DOM behind it. */
function fakeElement() {
  const target = new FakeTarget()
  const captured: number[] = []
  let lock: () => unknown = () => undefined
  let refuseCapture = false
  const element = {
    addEventListener: target.addEventListener.bind(target),
    removeEventListener: target.removeEventListener.bind(target),
    getBoundingClientRect: () => ({
      left: 40,
      top: 20,
      width: 640,
      height: 360,
    }),
    style: { touchAction: "pan-y" },
    setPointerCapture: (id: number) => {
      if (refuseCapture) throw new Error("NotFoundError")
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
    refuseCapture() {
      refuseCapture = true
    },
  }
}

/** A point `x`, `y` of the way across the element, as fractions. */
const at = (x: number, y: number) => ({
  clientX: 40 + x * 640,
  clientY: 20 + y * 360,
})

function manifestOf(
  inputs: Inputs,
  capabilities: Record<string, unknown> = {},
): Manifest {
  return { inputs, capabilities } as unknown as Manifest
}

function capture(
  inputs: Inputs,
  mapping: CaptureMapping,
  extra: { pointerLock?: boolean; element?: boolean } = {},
) {
  const queue = new LiveInputQueue(inputs)
  const browser = fakeBrowser()
  const element = fakeElement()
  const notices: DeviceNotice[] = []
  const helper = new InputCapture({
    manifest: manifestOf(inputs, { pointerLock: extra.pointerLock === true }),
    queue,
    ...mapping,
    ...(extra.element === false ? {} : { element: element.html }),
    onNotice: (notice) => notices.push(notice),
    environment: browser.environment,
  })
  helper.attach()
  return { queue, browser, element, notices, helper }
}

const taken = (queue: LiveInputQueue, tick = 0) =>
  queue.take(tick).map((e) => [e.code, e.value])

const PRESS = { min: 0, max: 1 }

describe("checking a mapping before anything starts", () => {
  const INPUTS: Inputs = {
    jump: PRESS,
    aimX: { min: 0, max: 31 },
    zoom: { min: -5, max: 5 },
    narrow: { min: 2, max: 2 },
    up: { min: 1, max: 3 },
  }
  const check = (mapping: CaptureMapping, capabilities = {}) =>
    checkCapture(mapping, manifestOf(INPUTS, capabilities))

  test("a mapping onto declared inputs with fitting ranges has no problem", () => {
    expect(
      check({
        keys: { Space: "jump" },
        pointers: [{ down: "jump", x: "aimX" }],
        wheel: { y: "zoom" },
      }),
    ).toEqual([])
  })

  // Each is a mapping that would record nothing, or what a server refuses.
  const PROBLEMS: readonly [string, CaptureMapping, RegExp][] = [
    [
      "an undeclared name",
      { keys: { Space: "fly" } },
      /not an input the manifest declares/,
    ],
    [
      "a misspelt key",
      { keys: { Arrowleft: "jump" } },
      /not a KeyboardEvent.code/,
    ],
    [
      "a press whose range cannot hold 1",
      { keys: { Space: "up" } },
      /must hold 0 and 1/,
    ],
    [
      "a position with two sources",
      { pointers: [{ x: "aimX" }], hover: { x: "aimX" } },
      /one source/,
    ],
    [
      "a name used as a press and a position",
      { keys: { Space: "aimX" }, hover: { x: "aimX" } },
      /more than one kind/,
    ],
    ["a level with one value", { hover: { x: "narrow" } }, /records nothing/],
    [
      "an amount whose range leaves out 0",
      { wheel: { y: "up" } },
      /must hold 0/,
    ],
    [
      "pointer button 0",
      { pointers: [{ buttons: { 0: "jump" } }] },
      /main button is down/,
    ],
    [
      "too many pointer slots",
      { pointers: Array.from({ length: POINTER_SLOTS + 1 }, () => ({})) },
      /at most/,
    ],
    [
      "a fifth gamepad",
      { gamepads: { 4: { buttons: { 0: "jump" } } } },
      /a slot is 0 to 3/,
    ],
    [
      "any beside a numbered gamepad",
      { gamepads: { any: {}, 0: {} } },
      /cannot sit beside/,
    ],
    [
      "a gamepad axis past the last",
      { gamepads: { 0: { axes: { 16: "aimX" } } } },
      /axis 16/,
    ],
    [
      "a unit of nothing",
      { wheel: { y: "zoom", notchesPerUnit: 0 } },
      /above 0/,
    ],
    ["tilt full at no angle", { tilt: { x: "aimX", fullAt: 0 } }, /fullAt/],
  ]
  for (const [name, mapping, why] of PROBLEMS) {
    test(`finds ${name}`, () => {
      expect(check(mapping).join("\n")).toMatch(why)
    })
  }

  test("mouse lock needs the manifest to say the game locks the pointer", () => {
    expect(check({ mouseLock: { dx: "zoom" } }).join()).toMatch(/pointerLock/)
    expect(check({ mouseLock: { dx: "zoom" } }, { pointerLock: true })).toEqual(
      [],
    )
  })

  test("the helper refuses a bad mapping when it is made", () => {
    const queue = new LiveInputQueue(INPUTS)
    expect(
      () =>
        new InputCapture({
          manifest: manifestOf(INPUTS),
          queue,
          keys: { Space: "fly" },
        }),
    ).toThrow(/E_ARG_INVALID/)
  })

  test("pointers or the wheel with no element to hear them on is refused", () => {
    // Otherwise the game builds, passes its checks and cannot be touched.
    const queue = new LiveInputQueue(INPUTS)
    expect(
      () =>
        new InputCapture({
          manifest: manifestOf(INPUTS),
          queue,
          pointers: [{ down: "jump" }],
        }),
    ).toThrow(/element is required/)
  })

  test("a gamepad with nowhere to report a blocked device is refused", () => {
    const queue = new LiveInputQueue(INPUTS)
    expect(
      () =>
        new InputCapture({
          manifest: manifestOf(INPUTS),
          queue,
          gamepads: { 0: { buttons: { 0: "jump" } } },
        }),
    ).toThrow(/onNotice is required/)
  })
})

describe("keys", () => {
  const INPUTS: Inputs = { left: PRESS, right: PRESS, jump: PRESS }
  const KEYS = {
    ArrowLeft: "left",
    ArrowRight: "right",
    KeyD: "right",
    Space: "jump",
  }
  const keys = () => capture(INPUTS, { keys: KEYS }, { element: false })

  test("a mapped key becomes the game's input, and an unmapped one is ignored", () => {
    const { queue, browser } = keys()
    browser.window.send("keydown", { code: "ArrowLeft", repeat: false })
    browser.window.send("keydown", { code: "Escape", repeat: false })
    expect(taken(queue)).toEqual([["left", 1]])
  })

  test("an auto-repeat does not push again", () => {
    // A held key would otherwise put one input per repeat into the log, at a
    // rate that differs between operating systems.
    const { queue, browser } = keys()
    browser.window.send("keydown", { code: "Space", repeat: false })
    browser.window.send("keydown", { code: "Space", repeat: true })
    expect(queue.take(0).length).toBe(1)
  })

  test("a key typed into a form on the page is the form's", () => {
    const { queue, browser } = keys()
    browser.window.send("keydown", {
      code: "Space",
      repeat: false,
      target: { tagName: "INPUT" },
    })
    browser.window.send("keydown", {
      code: "Space",
      repeat: false,
      target: { tagName: "DIV", isContentEditable: true },
    })
    expect(queue.take(0)).toEqual([])
  })

  test("only a mapped key is kept from the page", () => {
    const { browser } = keys()
    const prevented: string[] = []
    for (const code of ["Space", "Tab"]) {
      browser.window.send("keydown", {
        code,
        repeat: false,
        preventDefault: () => prevented.push(code),
      })
    }
    expect(prevented).toEqual(["Space"])
  })

  test("two keys for one input: it is down while either is", () => {
    const { queue, browser } = keys()
    browser.window.send("keydown", { code: "ArrowRight", repeat: false })
    browser.window.send("keydown", { code: "KeyD", repeat: false })
    browser.window.send("keyup", { code: "ArrowRight" })
    expect(taken(queue)).toEqual([["right", 1]])
    browser.window.send("keyup", { code: "KeyD" })
    expect(taken(queue, 1)).toEqual([["right", 0]])
  })

  test("a release is recorded once, and only if it was held", () => {
    const { queue, browser } = keys()
    browser.window.send("keyup", { code: "Space" })
    expect(queue.take(0)).toEqual([])
    browser.window.send("keydown", { code: "Space", repeat: false })
    browser.window.send("keyup", { code: "Space" })
    browser.window.send("keyup", { code: "Space" })
    expect(taken(queue, 1)).toEqual([
      ["jump", 1],
      ["jump", 0],
    ])
  })

  test("the page losing focus releases what was held", () => {
    const { queue, browser } = keys()
    browser.window.send("keydown", { code: "Space", repeat: false })
    browser.window.send("keydown", { code: "ArrowLeft", repeat: false })
    queue.take(0)
    browser.window.send("blur")
    expect(taken(queue, 1)).toEqual([
      ["jump", 0],
      ["left", 0],
    ])
  })

  test("a hidden tab releases what was held, and a visible one does not", () => {
    const { queue, browser } = keys()
    browser.window.send("keydown", { code: "Space", repeat: false })
    queue.take(0)
    browser.document.send("visibilitychange")
    expect(queue.take(1)).toEqual([])
    browser.document.visibilityState = "hidden"
    browser.document.send("visibilitychange")
    expect(taken(queue, 2)).toEqual([["jump", 0]])
  })

  test("a pause releases what was held, and nothing is taken until resume", () => {
    const { queue, browser } = keys()
    browser.window.send("keydown", { code: "Space", repeat: false })
    queue.take(0)
    queue.pause()
    browser.window.send("keydown", { code: "ArrowLeft", repeat: false })
    expect(taken(queue, 1)).toEqual([["jump", 0]])
  })

  test("a key held through a pause is not heard while paused, and its next repeat presses it again", () => {
    // The pause released it in the log; a key still down when the run
    // resumes is held, and the auto-repeat it sends is how the capture learns
    // so, since no fresh keydown comes.
    const { queue, browser } = keys()
    queue.pause()
    browser.window.send("keydown", { code: "ArrowLeft", repeat: false })
    queue.resume()
    expect(queue.take(0)).toEqual([])
    browser.window.send("keydown", { code: "ArrowLeft", repeat: true })
    expect(taken(queue, 1)).toEqual([["left", 1]])
    // And a repeat of a key already held is still nothing.
    browser.window.send("keydown", { code: "ArrowLeft", repeat: true })
    expect(queue.take(2)).toEqual([])
  })

  test("detach removes every listener, and attach works again", () => {
    const { queue, browser, helper } = keys()
    helper.attach()
    const listening = browser.window.count
    helper.detach()
    expect(browser.window.count).toBe(0)
    expect(browser.document.count).toBe(0)
    browser.window.send("keydown", { code: "Space", repeat: false })
    expect(queue.take(0)).toEqual([])
    helper.attach()
    expect(browser.window.count).toBe(listening)
  })
})

describe("pointers", () => {
  const INPUTS: Inputs = {
    aimX: { min: 0, max: 32 },
    aimY: { min: 0, max: 18 },
    touch: PRESS,
    touch2: PRESS,
    alt: PRESS,
    hoverX: { min: 0, max: 8 },
  }
  const MAPPING: CaptureMapping = {
    pointers: [
      { down: "touch", x: "aimX", y: "aimY", buttons: { 2: "alt" } },
      { down: "touch2" },
    ],
    hover: { x: "hoverX" },
  }
  const pointers = (mapping: CaptureMapping = MAPPING) =>
    capture(INPUTS, mapping)

  test("a press is measured in the declared range, position before press", () => {
    // A game hit-testing its own controls has to know where the finger
    // landed in the same tick it learns that it landed.
    const { queue, element } = pointers()
    element.target.send("pointerdown", {
      pointerId: 7,
      pointerType: "touch",
      buttons: 1,
      ...at(0.5, 0.5),
    })
    expect(taken(queue)).toEqual([
      ["aimX", 16],
      ["aimY", 9],
      ["touch", 1],
    ])
  })

  test("a press is captured, so its release arrives wherever the pointer goes", () => {
    const { element } = pointers()
    element.target.send("pointerdown", {
      pointerId: 3,
      buttons: 1,
      ...at(0.1, 0.1),
    })
    expect(element.captured).toEqual([3])
  })

  test("a capture that fails does not lose the press", () => {
    const { queue, element } = pointers()
    element.refuseCapture()
    element.target.send("pointerdown", {
      pointerId: 3,
      buttons: 1,
      ...at(0.1, 0.1),
    })
    expect(taken(queue)).toContainEqual(["touch", 1])
  })

  test("touch-action is set on the element, and given back on detach", () => {
    const { element, helper } = pointers()
    expect(element.element.style.touchAction).toBe("none")
    helper.detach()
    expect(element.element.style.touchAction).toBe("pan-y")
  })

  test("two fingers are told apart, and one lifting does not release the other", () => {
    const { queue, element } = pointers()
    element.target.send("pointerdown", {
      pointerId: 11,
      buttons: 1,
      ...at(0.1, 0.1),
    })
    element.target.send("pointerdown", {
      pointerId: 12,
      buttons: 1,
      ...at(0.9, 0.1),
    })
    queue.take(0)
    element.target.send("pointerup", {
      pointerId: 11,
      buttons: 0,
      ...at(0.1, 0.1),
    })
    expect(taken(queue, 1)).toEqual([["touch", 0]])
    element.target.send("pointerup", {
      pointerId: 12,
      buttons: 0,
      ...at(0.9, 0.1),
    })
    expect(taken(queue, 2)).toEqual([["touch2", 0]])
  })

  test("the capture lost after a release takes no slot, so the next finger is still slot 0", () => {
    // Every pointerup is followed by lostpointercapture for the same id. If
    // that took a fresh slot, slot 0 would stay taken after the first tap.
    const { queue, element } = pointers()
    element.target.send("pointerdown", {
      pointerId: 1,
      buttons: 1,
      ...at(0.1, 0.1),
    })
    element.target.send("pointerup", {
      pointerId: 1,
      buttons: 0,
      ...at(0.1, 0.1),
    })
    element.target.send("lostpointercapture", {
      pointerId: 1,
      buttons: 0,
      ...at(0.1, 0.1),
    })
    queue.take(0)
    element.target.send("pointerdown", {
      pointerId: 2,
      buttons: 1,
      ...at(0.2, 0.2),
    })
    expect(taken(queue, 1)).toContainEqual(["touch", 1])
  })

  test("a capture lost while held is a release, unless a button is still down", () => {
    const { queue, element } = pointers()
    element.target.send("pointerdown", {
      pointerId: 4,
      buttons: 1,
      ...at(0.1, 0.1),
    })
    queue.take(0)
    // Still down: something else took the capture, and it is taken back.
    element.target.send("lostpointercapture", {
      pointerId: 4,
      buttons: 1,
      ...at(0.5, 0.5),
    })
    expect(queue.take(1)).toEqual([])
    expect(element.captured).toEqual([4, 4])
    element.target.send("lostpointercapture", {
      pointerId: 4,
      buttons: 0,
      ...at(0.5, 0.5),
    })
    expect(taken(queue, 2)).toEqual([["touch", 0]])
  })

  test("a release the element never heard still ends the press", () => {
    const { queue, element, browser } = pointers()
    element.target.send("pointerdown", {
      pointerId: 5,
      buttons: 1,
      ...at(0.1, 0.1),
    })
    queue.take(0)
    browser.window.send("pointerup", {
      pointerId: 5,
      buttons: 0,
      ...at(0.1, 0.1),
    })
    expect(taken(queue, 1)).toEqual([["touch", 0]])
  })

  test("a cancelled pointer releases and frees its slot", () => {
    const { queue, element } = pointers()
    element.target.send("pointerdown", {
      pointerId: 9,
      buttons: 1,
      ...at(0.1, 0.1),
    })
    element.target.send("pointercancel", { pointerId: 9, ...at(0, 0) })
    expect(taken(queue).at(-1)).toEqual(["touch", 0])
    element.target.send("pointerdown", {
      pointerId: 10,
      buttons: 1,
      ...at(0.1, 0.1),
    })
    expect(taken(queue, 1)).toContainEqual(["touch", 1])
  })

  test("a resting mouse takes no slot, so a touch beside it is still slot 0", () => {
    const { queue, element } = pointers()
    element.target.send("pointermove", {
      pointerId: 1,
      pointerType: "mouse",
      buttons: 0,
      ...at(0.5, 0.5),
    })
    expect(taken(queue)).toEqual([["hoverX", 4]])
    element.target.send("pointerdown", {
      pointerId: 2,
      pointerType: "touch",
      buttons: 1,
      ...at(0.1, 0.1),
    })
    expect(taken(queue, 1)).toContainEqual(["touch", 1])
  })

  test("a finger cannot hover, and an unchanged position records nothing", () => {
    const { queue, element } = pointers()
    element.target.send("pointermove", {
      pointerId: 1,
      pointerType: "touch",
      buttons: 0,
      ...at(0.5, 0.5),
    })
    expect(queue.take(0)).toEqual([])
    element.target.send("pointerdown", {
      pointerId: 2,
      buttons: 1,
      ...at(0.5, 0.5),
    })
    queue.take(1)
    element.target.send("pointermove", {
      pointerId: 2,
      buttons: 1,
      ...at(0.501, 0.501),
    })
    expect(queue.take(2)).toEqual([])
  })

  test("a finger past the mapped slots records nothing", () => {
    const { queue, element } = pointers()
    for (const id of [1, 2, 3]) {
      element.target.send("pointerdown", {
        pointerId: id,
        buttons: 1,
        ...at(0.1, 0.1),
      })
    }
    const presses = queue
      .take(0)
      .filter((e) => e.value === 1)
      .map((e) => e.code)
    expect(presses).toEqual(["touch", "touch2"])
  })

  test(`a finger past the ${POINTER_SLOTS} slots is dropped`, () => {
    const mapping: CaptureMapping = {
      pointers: [
        ...Array.from({ length: POINTER_SLOTS - 1 }, () => ({})),
        { down: "touch" },
      ],
    }
    const { queue, element } = capture(INPUTS, mapping)
    for (let id = 0; id <= POINTER_SLOTS; id++) {
      element.target.send("pointerdown", {
        pointerId: id,
        buttons: 1,
        ...at(0.1, 0.1),
      })
    }
    expect(taken(queue)).toEqual([["touch", 1]])
    expect(element.captured.length).toBe(POINTER_SLOTS)
  })

  test("a second mouse button is heard from a move, as browsers send it", () => {
    const { queue, element } = pointers()
    element.target.send("pointerdown", {
      pointerId: 1,
      buttons: 1,
      ...at(0.1, 0.1),
    })
    queue.take(0)
    element.target.send("pointermove", {
      pointerId: 1,
      buttons: 3,
      ...at(0.1, 0.1),
    })
    expect(taken(queue, 1)).toEqual([["alt", 1]])
    element.target.send("pointermove", {
      pointerId: 1,
      buttons: 1,
      ...at(0.1, 0.1),
    })
    expect(taken(queue, 2)).toEqual([["alt", 0]])
  })

  test("a right press alone is the pointer down and its right button", () => {
    const { queue, element } = pointers()
    element.target.send("pointerdown", {
      pointerId: 1,
      buttons: 2,
      ...at(0.1, 0.1),
    })
    expect(taken(queue).slice(-2)).toEqual([
      ["touch", 1],
      ["alt", 1],
    ])
  })

  test("the right-click menu stays shut only when a right button is mapped", () => {
    const prevented: string[] = []
    const menu = { preventDefault: () => prevented.push("menu") }
    pointers().element.target.send("contextmenu", menu)
    expect(prevented).toEqual(["menu"])
    pointers({ pointers: [{ down: "touch" }] }).element.target.send(
      "contextmenu",
      menu,
    )
    expect(prevented).toEqual(["menu"])
  })

  test("releasing everything frees every pointer's slot", () => {
    const { queue, element, browser } = pointers()
    element.target.send("pointerdown", {
      pointerId: 1,
      buttons: 1,
      ...at(0.1, 0.1),
    })
    queue.take(0)
    browser.window.send("blur")
    expect(taken(queue, 1)).toEqual([["touch", 0]])
    element.target.send("pointerup", {
      pointerId: 1,
      buttons: 0,
      ...at(0.1, 0.1),
    })
    expect(queue.take(2)).toEqual([])
  })
})

describe("the mouse locked to the game", () => {
  const INPUTS: Inputs = {
    lookX: { min: -50, max: 50 },
    lookY: { min: -50, max: 50 },
    fire: PRESS,
  }
  const lock = (pixelsPerUnit?: number) =>
    capture(
      INPUTS,
      {
        mouseLock: {
          dx: "lookX",
          dy: "lookY",
          ...(pixelsPerUnit === undefined ? {} : { pixelsPerUnit }),
        },
        pointers: [{ down: "fire" }],
      },
      { pointerLock: true },
    )

  test("a press asks for the lock", () => {
    const { element } = lock()
    let asked = 0
    element.onLock(() => {
      asked++
    })
    element.target.send("pointerdown", {
      pointerId: 1,
      buttons: 1,
      ...at(0.5, 0.5),
    })
    expect(asked).toBe(1)
  })

  test("while locked, movement is summed per tick in units, the fraction carried, and no capture is taken", () => {
    const { queue, element, browser } = lock(2)
    browser.document.pointerLockElement = element.element
    for (const movementX of [3, 4.5, -1]) {
      element.target.send("pointermove", {
        pointerId: 1,
        buttons: 0,
        ...at(0.5, 0.5),
        movementX,
        movementY: 8,
      })
    }
    // (3 + 4.5 - 1) / 2 = 3.25: three whole units, a quarter carried.
    expect(taken(queue)).toEqual([
      ["lookX", 3],
      ["lookY", 12],
    ])
    element.target.send("pointerdown", {
      pointerId: 1,
      buttons: 1,
      ...at(0.5, 0.5),
    })
    expect(element.captured).toEqual([])
    expect(taken(queue, 1)).toEqual([["fire", 1]])
  })

  test("a refused lock is reported, whether the browser rejects or throws", async () => {
    const { element, notices } = lock()
    element.onLock(() => Promise.reject(new Error("no gesture")))
    element.target.send("pointerdown", {
      pointerId: 1,
      buttons: 1,
      ...at(0.5, 0.5),
    })
    element.target.send("pointerup", {
      pointerId: 1,
      buttons: 0,
      ...at(0.5, 0.5),
    })
    await Promise.resolve()
    element.onLock(() => {
      throw new Error("not allowed")
    })
    element.target.send("pointerdown", {
      pointerId: 2,
      buttons: 1,
      ...at(0.5, 0.5),
    })
    expect(notices.map((n) => n.code)).toEqual([
      DEVICE_NOTICES.POINTER_LOCK_REFUSED,
      DEVICE_NOTICES.POINTER_LOCK_REFUSED,
    ])
  })

  test("a refusal sent only as pointerlockerror, as Firefox sends it, is reported", () => {
    const { element, notices, browser } = lock()
    element.onLock(() => undefined)
    element.target.send("pointerdown", {
      pointerId: 1,
      buttons: 1,
      ...at(0.5, 0.5),
    })
    expect(notices).toEqual([])
    browser.document.send("pointerlockerror")
    expect(notices.map((n) => n.code)).toEqual([
      DEVICE_NOTICES.POINTER_LOCK_REFUSED,
    ])
  })

  test("a refusal sent both ways, as WebKit sends it, is reported once", async () => {
    const { element, notices, browser } = lock()
    element.onLock(() => Promise.reject(new Error("WrongDocumentError")))
    element.target.send("pointerdown", {
      pointerId: 1,
      buttons: 1,
      ...at(0.5, 0.5),
    })
    browser.document.send("pointerlockerror")
    await Promise.resolve()
    expect(notices.map((n) => n.code)).toEqual([
      DEVICE_NOTICES.POINTER_LOCK_REFUSED,
    ])
  })

  test("a pointerlockerror after the lock was granted is not a refusal", () => {
    const { element, notices, browser } = lock()
    element.onLock(() => undefined)
    element.target.send("pointerdown", {
      pointerId: 1,
      buttons: 1,
      ...at(0.5, 0.5),
    })
    browser.document.pointerLockElement = element.element
    browser.document.send("pointerlockchange")
    browser.document.send("pointerlockerror")
    expect(notices).toEqual([])
  })

  test("leaving the lock releases everything", () => {
    const { queue, element, browser } = lock()
    browser.document.pointerLockElement = element.element
    element.target.send("pointerdown", {
      pointerId: 1,
      buttons: 1,
      ...at(0.5, 0.5),
    })
    queue.take(0)
    browser.document.pointerLockElement = null
    browser.document.send("pointerlockchange")
    expect(taken(queue, 1)).toEqual([["fire", 0]])
  })
})

describe("the wheel", () => {
  const INPUTS: Inputs = {
    zoom: { min: -10, max: 10 },
    pan: { min: -10, max: 10 },
  }
  const wheelCapture = (notchesPerUnit?: number) =>
    capture(INPUTS, {
      wheel: {
        y: "zoom",
        ...(notchesPerUnit === undefined ? {} : { notchesPerUnit }),
      },
    })
  const wheel = (deltaMode: number, deltaY: number, deltaX = 0) => ({
    deltaMode,
    deltaX,
    deltaY,
  })

  test("pixels become whole notches, added up per tick, the fraction carried", () => {
    const { queue, element } = wheelCapture()
    element.target.send("wheel", wheel(0, 250))
    element.target.send("wheel", wheel(0, 30))
    expect(taken(queue)).toEqual([["zoom", 2]])
    element.target.send("wheel", wheel(0, 20))
    expect(taken(queue, 1)).toEqual([["zoom", 1]])
  })

  test("lines are three to a notch, a page is one, and a unit can be several notches", () => {
    const { queue, element } = wheelCapture()
    element.target.send("wheel", wheel(1, -3))
    expect(taken(queue)).toEqual([["zoom", -1]])
    element.target.send("wheel", wheel(2, 2))
    expect(taken(queue, 1)).toEqual([["zoom", 2]])
    const coarse = wheelCapture(4)
    coarse.element.target.send("wheel", wheel(2, 6))
    expect(taken(coarse.queue)).toEqual([["zoom", 1]])
  })

  test("the mode is read before any delta", () => {
    // Firefox reports lines only to a listener that asks for the mode first.
    const { element } = wheelCapture()
    const reads: string[] = []
    element.target.send("wheel", {
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
    })
    expect(reads[0]).toBe("deltaMode")
  })

  test("the listener is on the game's element and not passive, so the page does not scroll", () => {
    const { element } = wheelCapture()
    expect(element.target.options.get("wheel")).toEqual({ passive: false })
    let prevented = false
    element.target.send("wheel", {
      ...wheel(0, 100),
      preventDefault: () => {
        prevented = true
      },
    })
    expect(prevented).toBe(true)
  })

  test("an unknown mode and an unmapped axis record nothing", () => {
    const { queue, element } = wheelCapture()
    element.target.send("wheel", wheel(7, 300))
    element.target.send("wheel", wheel(0, 0, 500))
    expect(queue.take(0)).toEqual([])
  })

  test("a flick past the range is held to it", () => {
    const { queue, element } = wheelCapture()
    element.target.send("wheel", wheel(0, 3000))
    expect(taken(queue)).toEqual([["zoom", 10]])
  })
})

describe("gamepads", () => {
  const INPUTS: Inputs = {
    jump: PRESS,
    brake: { min: 0, max: 10 },
    steer: { min: -10, max: 10 },
    jump2: PRESS,
  }
  const MAPPING: CaptureMapping = {
    gamepads: {
      0: {
        buttons: { 0: "jump" },
        values: { 6: "brake" },
        axes: { 0: "steer" },
      },
      1: { buttons: { 0: "jump2" } },
    },
  }
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
  const SEVEN = (): [boolean, number][] =>
    Array.from({ length: 7 }, () => [false, 0])
  const pads = (mapping: CaptureMapping = MAPPING) =>
    capture(INPUTS, mapping, { element: false })

  test("an untouched controller records nothing", () => {
    const { queue, browser } = pads()
    browser.setPads([pad(0, SEVEN(), [0])])
    queue.poll()
    expect(queue.take(0)).toEqual([])
  })

  test("a poll reads presses, trigger travel and sticks in their ranges, once until they change", () => {
    const { queue, browser } = pads()
    const buttons = SEVEN()
    buttons[0] = [true, 1]
    buttons[6] = [false, 0.5]
    browser.setPads([pad(0, buttons, [1])])
    queue.poll()
    expect(taken(queue)).toEqual([
      ["jump", 1],
      ["brake", 5],
      ["steer", 10],
    ])
    queue.poll()
    expect(queue.take(1)).toEqual([])
  })

  test("polls between ticks leave a stick's last value only", () => {
    const { queue, browser } = pads()
    for (const x of [0.3, 0.6, -1]) {
      browser.setPads([pad(0, SEVEN(), [x])])
      queue.poll()
    }
    expect(taken(queue)).toEqual([["steer", -10]])
  })

  test("an unplugged controller lets go of its buttons and centres its sticks", () => {
    const { queue, browser } = pads()
    const buttons = SEVEN()
    buttons[0] = [true, 1]
    browser.setPads([pad(0, buttons, [-1])])
    queue.poll()
    queue.take(0)
    browser.setPads([null])
    queue.poll()
    expect(taken(queue, 1)).toEqual([
      ["jump", 0],
      ["steer", 0],
    ])
  })

  test("releasing everything centres the sticks, and a button still down is pressed again", () => {
    const { queue, browser } = pads()
    const buttons = SEVEN()
    buttons[0] = [true, 1]
    browser.setPads([pad(0, buttons, [1])])
    queue.poll()
    queue.take(0)
    browser.window.send("blur")
    expect(taken(queue, 1)).toEqual([
      ["jump", 0],
      ["steer", 0],
    ])
    queue.poll()
    expect(taken(queue, 2)).toEqual([
      ["jump", 1],
      ["steer", 10],
    ])
  })

  test("any plays whichever controller is first, so a swapped pad still steers", () => {
    const { queue, browser } = pads({
      gamepads: { any: { buttons: { 0: "jump" } } },
    })
    browser.setPads([null, pad(1, [[true, 1]], [])])
    queue.poll()
    expect(taken(queue)).toEqual([["jump", 1]])
  })

  test("with any, a spectator controller leaving touches nothing the playing one holds", () => {
    const INPUTS_ANY: Inputs = { jump: PRESS, steer: { min: -10, max: 10 } }
    const { queue, browser } = capture(
      INPUTS_ANY,
      { gamepads: { any: { buttons: { 0: "jump" }, axes: { 0: "steer" } } } },
      { element: false },
    )
    const playing = pad(0, [[true, 1]], [1])
    browser.setPads([playing, pad(1, [[false, 0]], [0])])
    queue.poll()
    expect(taken(queue)).toEqual([
      ["jump", 1],
      ["steer", 10],
    ])
    // Pad 1 is unplugged while pad 0 still holds and steers.
    browser.setPads([playing, null])
    queue.poll()
    expect(queue.take(1)).toEqual([])
    // Pad 0 leaving does release, and the next pad up plays from rest.
    browser.setPads([null, pad(1, [[false, 0]], [0])])
    queue.poll()
    expect(taken(queue, 2)).toEqual([
      ["jump", 0],
      ["steer", 0],
    ])
  })

  test("a paused run polls no controller, so nothing is read until it resumes", () => {
    const { queue, browser } = pads()
    queue.pause()
    browser.setPads([pad(0, [[true, 1]], [])])
    queue.poll()
    queue.resume()
    expect(queue.take(0)).toEqual([])
    queue.poll()
    expect(taken(queue, 1)).toEqual([["jump", 1]])
  })

  test("a page that forbids gamepads is reported once, and nothing is read after", () => {
    const { queue, browser, notices } = pads()
    browser.block(new Error("SecurityError"))
    queue.poll()
    queue.poll()
    expect(notices.map((n) => n.code)).toEqual([DEVICE_NOTICES.GAMEPAD_BLOCKED])
    expect(queue.take(0)).toEqual([])
  })

  test("a controller with no standard layout is reported once, and still recorded", () => {
    const { queue, browser, notices } = pads()
    browser.setPads([pad(1, [[true, 1]], [], "", "odd stick")])
    queue.poll()
    queue.poll()
    expect(notices).toEqual([
      {
        code: DEVICE_NOTICES.GAMEPAD_UNMAPPED,
        detail: "gamepad 1 (odd stick) has no standard layout",
      },
    ])
    expect(taken(queue)).toEqual([["jump2", 1]])
  })

  test("a controller past the fourth is ignored, and detach stops the polling", () => {
    const { queue, browser, helper } = pads()
    browser.setPads([pad(4, [[true, 1]], [1])])
    queue.poll()
    expect(queue.take(0)).toEqual([])
    helper.detach()
    browser.setPads([pad(0, [[true, 1]], [])])
    queue.poll()
    expect(queue.take(1)).toEqual([])
  })
})

describe("tilt", () => {
  const INPUTS: Inputs = {
    lean: { min: -100, max: 100 },
    pitch: { min: -100, max: 100 },
    face: { min: -100, max: 100 },
  }
  function tilt(fullAt?: number) {
    const made = capture(
      INPUTS,
      {
        tilt: {
          x: "lean",
          y: "pitch",
          z: "face",
          ...(fullAt === undefined ? {} : { fullAt }),
        },
      },
      { element: false },
    )
    const read = (beta: unknown, gamma: unknown, isTrusted = true) =>
      made.browser.window.send("deviceorientation", { beta, gamma, isTrusted })
    return { ...made, read }
  }

  test("flat on a table, face up, gravity points into the table", () => {
    const { queue, read } = tilt()
    read(0, 0)
    expect(taken(queue)).toEqual([
      ["lean", 0],
      ["pitch", 0],
      ["face", -100],
    ])
  })

  test("the right edge tipped down 30 degrees reads half of gravity to the right", () => {
    const { queue, read } = tilt()
    read(0, 30)
    expect(taken(queue)).toContainEqual(["lean", 50])
  })

  test("full at 30 degrees, a 30 degree tip reads the end of the range", () => {
    const { queue, read } = tilt(30)
    read(0, 30)
    expect(taken(queue)).toContainEqual(["lean", 100])
  })

  test("held upright, gravity points down the screen", () => {
    const { queue, read } = tilt()
    read(90, 0)
    expect(taken(queue)).toContainEqual(["pitch", -100])
  })

  test("the axes turn with the screen", () => {
    const { queue, read, browser } = tilt()
    browser.turn(90)
    read(90, 0)
    const values = new Map(queue.take(0).map((e) => [e.code, e.value]))
    expect(values.get("lean")).toBe(100)
    expect(values.get("pitch")).toBe(0)
  })

  test("a reading inside the deadband records nothing", () => {
    // A hand-held phone resting near a unit boundary would otherwise record
    // an input on every reading.
    const { queue, read } = tilt()
    read(0, 0)
    queue.take(0)
    read(0, 0.4)
    expect(queue.take(1)).toEqual([])
    read(0, 2)
    expect(taken(queue, 2)).toEqual([["lean", 3]])
  })

  test("a malformed, untrusted or unturnable reading is dropped, never recorded as lying flat", () => {
    const { queue, read, browser } = tilt()
    for (const [beta, gamma] of [
      [Number.NaN, 0],
      [null, 0],
      [200, 0],
      [0, 95],
    ]) {
      read(beta, gamma)
    }
    read(0, 0, false)
    browser.turn(45)
    read(0, 0)
    browser.turn(undefined)
    read(0, 0)
    expect(queue.take(0)).toEqual([])
  })

  test("the screen's turn is read as one of four quarter turns", () => {
    expect(screenRotation(0)).toBe(0)
    expect(screenRotation(-90)).toBe(270)
    expect(screenRotation(450)).toBe(90)
    expect(screenRotation(45)).toBeUndefined()
    expect(screenRotation(undefined)).toBeUndefined()
  })
})
