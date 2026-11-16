import { describe, expect, test } from "bun:test"
import type { InputEvent } from "../../src/contract"
import { MAX_INPUTS_PER_TICK } from "../../src/input-codes"
import {
  checkInputs,
  LiveInputQueue,
  quantiseAxis,
  quantisePoint,
  RecordedInputSource,
  validateInputLog,
} from "../../src/inputs"
import type { Inputs } from "../../src/manifest/types"

const event = (tick: number, code = "left", value = 1): InputEvent => ({
  tick,
  device: "key",
  code,
  value,
})

describe("input log validation", () => {
  test("accepts a sorted log", () => {
    expect(() =>
      validateInputLog([event(0), event(0), event(5), event(9)]),
    ).not.toThrow()
  })

  test("refuses an out-of-order log", () => {
    expect(() => validateInputLog([event(5), event(4)])).toThrow(
      /E_INPUT_UNSORTED/,
    )
  })

  test("refuses a non-finite or fractional tick", () => {
    // Clockwork 1 checked that deltas were numbers above zero, which let NaN
    // and Infinity through; they then stalled every replay forever.
    for (const tick of [Number.NaN, Number.POSITIVE_INFINITY, -1, 1.5]) {
      expect(() => validateInputLog([event(tick)]), String(tick)).toThrow(
        /E_INPUT_RANGE/,
      )
    }
  })

  test("refuses a non-integer value", () => {
    expect(() => validateInputLog([{ ...event(0), value: 0.5 }])).toThrow(
      /E_INPUT_RANGE/,
    )
    expect(() =>
      validateInputLog([{ ...event(0), value: Number.NaN }]),
    ).toThrow(/E_INPUT_RANGE/)
  })

  test("refuses an unknown device and an empty code", () => {
    expect(() =>
      validateInputLog([{ ...event(0), device: "telepathy" as never }]),
    ).toThrow(/E_INPUT_RANGE/)
    expect(() => validateInputLog([{ ...event(0), code: "" }])).toThrow(
      /E_INPUT_RANGE/,
    )
  })

  test("refuses an input past the end of the run", () => {
    expect(() => validateInputLog([event(10)], { endTick: 5 })).toThrow(
      /E_INPUT_RANGE/,
    )
  })
})

describe("RecordedInputSource", () => {
  test("hands out exactly the inputs for each tick", () => {
    const source = new RecordedInputSource([
      event(0),
      event(2, "a"),
      event(2, "b"),
      event(5),
    ])
    expect(source.take(0).length).toBe(1)
    expect(source.take(1).length).toBe(0)
    expect(source.take(2).map((e) => e.code)).toEqual(["a", "b"])
    expect(source.take(3).length).toBe(0)
    expect(source.take(4).length).toBe(0)
    expect(source.take(5).length).toBe(1)
    expect(source.take(6).length).toBe(0)
    expect(source.consumed).toBe(4)
  })

  test("refuses to skip a tick that had input waiting", () => {
    // Silently flushing a late input is how Clockwork 1's recorded source
    // papered over tick drift instead of failing loudly.
    const source = new RecordedInputSource([event(3)])
    expect(() => source.take(4)).toThrow(/E_INPUT_UNSORTED/)
  })

  test("seek moves past everything before a tick", () => {
    const source = new RecordedInputSource([event(1), event(2), event(7)])
    source.seek(7)
    expect(source.take(7).length).toBe(1)
  })
})

describe("LiveInputQueue", () => {
  test("stamps an input with the tick that is about to run", () => {
    // This is the whole difference from Clockwork 1, which stamped at drain
    // time so the same keystroke landed on a different tick at a different
    // frame rate.
    const queue = new LiveInputQueue()
    queue.push({ device: "key", code: "left", value: 1 })
    queue.push({ device: "key", code: "thrust", value: 1 })
    const taken = queue.take(42)
    expect(taken.map((e) => e.tick)).toEqual([42, 42])
    expect(queue.pendingCount).toBe(0)
    expect(queue.take(43).length).toBe(0)
    expect(queue.recorded().length).toBe(2)
  })

  test("refuses a non-integer value at the point of entry", () => {
    const queue = new LiveInputQueue()
    expect(() =>
      queue.push({ device: "gamepad", code: "axis0", value: 0.7 }),
    ).toThrow(/E_INPUT_RANGE/)
  })

  test("a level marked latest keeps only the last value of a tick", () => {
    // A stick polled three times before a tick runs needs one input, where
    // it ended up, not three.
    const queue = new LiveInputQueue()
    queue.push({ device: "gamepad", code: "steer", value: 10, merge: "latest" })
    queue.push({ device: "key", code: "jump", value: 1 })
    queue.push({ device: "gamepad", code: "steer", value: 40, merge: "latest" })
    queue.push({ device: "gamepad", code: "lean", value: 5, merge: "latest" })
    const taken = queue.take(3)
    expect(taken.map((e) => [e.code, e.value])).toEqual([
      ["jump", 1],
      ["steer", 40],
      ["lean", 5],
    ])
    // The merge rule is the queue's business, not the log's.
    expect(Object.keys(taken[1] ?? {}).sort()).toEqual([
      "code",
      "device",
      "tick",
      "value",
    ])
    // And it never reaches across ticks.
    queue.push({ device: "gamepad", code: "steer", value: 41, merge: "latest" })
    expect(queue.take(4).map((e) => e.value)).toEqual([41])
  })

  test("an amount marked sum is added up, and a sum of nothing is dropped", () => {
    const queue = new LiveInputQueue()
    queue.push({ device: "wheel", code: "zoom", value: 2, merge: "sum" })
    queue.push({ device: "wheel", code: "zoom", value: 3, merge: "sum" })
    expect(queue.take(1).map((e) => e.value)).toEqual([5])
    queue.push({ device: "wheel", code: "zoom", value: 2, merge: "sum" })
    queue.push({ device: "wheel", code: "zoom", value: -2, merge: "sum" })
    queue.push({ device: "wheel", code: "zoom", value: 0, merge: "sum" })
    expect(queue.take(2)).toEqual([])
  })

  test("presses and pointer positions are never merged", () => {
    // A game hit-testing a touch reads the position before the press in the
    // same tick, so order and every value matter.
    const queue = new LiveInputQueue()
    queue.push({ device: "pointer", code: "aimX", value: 3 })
    queue.push({ device: "pointer", code: "touch", value: 1 })
    queue.push({ device: "pointer", code: "aimX", value: 4 })
    expect(queue.take(0).map((e) => [e.code, e.value])).toEqual([
      ["aimX", 3],
      ["touch", 1],
      ["aimX", 4],
    ])
  })

  test("a poller runs on each poll until it is removed", () => {
    const queue = new LiveInputQueue()
    let polled = 0
    const stop = queue.addPoller(() => {
      polled++
    })
    queue.poll()
    queue.poll()
    stop()
    queue.poll()
    expect(polled).toBe(2)
  })

  test("the log it builds validates", () => {
    const queue = new LiveInputQueue()
    for (let tick = 0; tick < 100; tick += 7) {
      queue.push({ device: "key", code: "left", value: tick % 2 })
      queue.take(tick)
    }
    expect(() => validateInputLog(queue.recorded())).not.toThrow()
  })
})

describe("quantisation", () => {
  test("a reading inside the deadzone is zero", () => {
    expect(quantiseAxis(0.05)).toBe(0)
    expect(quantiseAxis(-0.05)).toBe(0)
    expect(quantiseAxis(0)).toBe(0)
  })

  test("the deadzone is rescaled rather than clipped", () => {
    // Just past the deadzone should read as a small movement, not a jump.
    const justPast = quantiseAxis(0.09)
    expect(justPast).toBeGreaterThan(0)
    expect(justPast).toBeLessThan(20)
    expect(quantiseAxis(1)).toBe(1000)
    expect(quantiseAxis(-1)).toBe(-1000)
  })

  test("readings are clamped and never non-integer", () => {
    for (const value of [
      -5,
      5,
      Number.NaN,
      Number.POSITIVE_INFINITY,
      0.3333333,
    ]) {
      const result = quantiseAxis(value)
      expect(Number.isInteger(result), String(value)).toBe(true)
      expect(Math.abs(result)).toBeLessThanOrEqual(1000)
    }
  })

  test("a pointer maps into simulation units and stays inside them", () => {
    expect(quantisePoint(0, 800, 640)).toBe(0)
    expect(quantisePoint(800, 800, 640)).toBe(640)
    expect(quantisePoint(400, 800, 640)).toBe(320)
    expect(quantisePoint(-50, 800, 640)).toBe(0)
    expect(quantisePoint(5000, 800, 640)).toBe(640)
    expect(quantisePoint(Number.NaN, 800, 640)).toBe(0)
  })
})

describe("checking a log against the manifest", () => {
  const INPUTS: Inputs = {
    map: {
      jump: [{ code: "Space" }, { code: "gamepad0-button0" }],
      touch: [{ code: "pointer0" }],
      aimX: [{ code: "pointer0-x" }],
      steer: [{ code: "gamepad0-axis0" }],
      zoom: [{ code: "wheel-y" }],
      lean: [{ code: "tilt-x" }],
    },
    viewport: { width: 320, height: 480 },
  }
  const at = (
    tick: number,
    device: InputEvent["device"],
    code: string,
    value: number,
  ): InputEvent => ({ tick, device, code, value })

  test("a log of bound inputs within their ranges passes", () => {
    expect(() =>
      checkInputs(
        [
          at(0, "key", "jump", 1),
          at(0, "gamepad", "jump", 0),
          at(1, "pointer", "aimX", 0),
          at(1, "pointer", "aimX", 320),
          at(1, "pointer", "touch", 1),
          at(2, "gamepad", "steer", -100),
          at(2, "wheel", "zoom", -3),
          at(3, "motion", "lean", 100),
        ],
        INPUTS,
      ),
    ).not.toThrow()
  })

  // Each is a log a browser following the manifest could not have made.
  const REFUSED: readonly [string, InputEvent][] = [
    ["an action nothing binds", at(0, "key", "fly", 1)],
    ["a device the action is not bound to", at(0, "wheel", "jump", 1)],
    ["a press that is not 0 or 1", at(0, "key", "jump", 7)],
    ["a position past the viewport", at(0, "pointer", "aimX", 321)],
    ["a position below zero", at(0, "pointer", "aimX", -1)],
    ["a stick past full deflection", at(0, "gamepad", "steer", 101)],
    ["a wheel input of nothing", at(0, "wheel", "zoom", 0)],
    ["tilt past full gravity", at(0, "motion", "lean", -101)],
  ]
  for (const [name, input] of REFUSED) {
    test(`refuses ${name}`, () => {
      expect(() => checkInputs([input], INPUTS)).toThrow(/E_INPUT_UNBOUND/)
    })
  }

  test("refuses more inputs in one tick than a person could make", () => {
    const flood = Array.from({ length: MAX_INPUTS_PER_TICK + 1 }, () =>
      at(5, "key", "jump", 1),
    )
    expect(() => checkInputs(flood, INPUTS)).toThrow(/E_INPUT_UNBOUND@5/)
    expect(() => checkInputs(flood.slice(1), INPUTS)).not.toThrow()
  })

  test("checks the log's shape first", () => {
    expect(() =>
      checkInputs([at(5, "key", "jump", 1), at(4, "key", "jump", 0)], INPUTS),
    ).toThrow(/E_INPUT_UNSORTED/)
  })
})
