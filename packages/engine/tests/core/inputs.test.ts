import { describe, expect, test } from "bun:test"
import type { InputEvent } from "../../src/contract"
import {
  checkInputSpan,
  checkInputs,
  INPUT_BUDGET_PER_TICK,
  LiveInputQueue,
  MAX_INPUTS_PER_TICK,
  quantiseAxis,
  quantisePoint,
  RecordedInputSource,
  validateInputLog,
} from "../../src/inputs"
import type { Inputs } from "../../src/manifest/types"

const event = (tick: number, code = "left", value = 1): InputEvent => ({
  tick,
  code,
  value,
})

/** The inputs the queue tests declare. */
const INPUTS: Inputs = {
  left: { min: 0, max: 1 },
  right: { min: 0, max: 1 },
  thrust: { min: 0, max: 1 },
  tap: { min: 0, max: 1 },
  aimX: { min: 0, max: 32 },
  aimY: { min: 0, max: 18 },
  steer: { min: -10, max: 10 },
  zoom: { min: -5, max: 5 },
}

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

  test("refuses a non-integer value, and -0", () => {
    // Stored as JSON, -0 comes back as 0, so a run replayed from what was
    // submitted and the same run rebuilt from stored chunks would differ.
    for (const value of [0.5, Number.NaN, -0]) {
      expect(
        () => validateInputLog([{ ...event(0), value }]),
        String(value),
      ).toThrow(/E_INPUT_RANGE/)
    }
  })

  test("refuses an empty code", () => {
    expect(() => validateInputLog([{ ...event(0), code: "" }])).toThrow(
      /E_INPUT_RANGE/,
    )
  })

  test("accepts and ignores the device an older recording carries", () => {
    // Recording versions 1 and 2 named a device on every input. A frozen
    // recording must still replay, so the field is read past, not refused.
    const older = [{ tick: 0, device: "key", code: "left", value: 1 }]
    expect(() =>
      validateInputLog(older as unknown as InputEvent[]),
    ).not.toThrow()
    const source = new RecordedInputSource(older as unknown as InputEvent[])
    expect(source.take(0)).toEqual([{ tick: 0, code: "left", value: 1 }])
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

  test("hands out copies, so nothing riding on an input reaches tick", () => {
    const log = [{ ...event(0), extra: "x" }] as unknown as InputEvent[]
    const source = new RecordedInputSource(log)
    const [taken] = source.take(0)
    expect(taken).toEqual({ tick: 0, code: "left", value: 1 })
    expect(taken).not.toBe(log[0])
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

const taken = (queue: LiveInputQueue, tick = 0) =>
  queue.take(tick).map((e) => [e.code, e.value])

describe("LiveInputQueue", () => {
  test("stamps an input with the tick that is about to run", () => {
    // This is the whole difference from Clockwork 1, which stamped at drain
    // time so the same keystroke landed on a different tick at a different
    // frame rate.
    const queue = new LiveInputQueue(INPUTS)
    queue.push({ code: "left", value: 1 })
    queue.push({ code: "thrust", value: 1 })
    const stamped = queue.take(42)
    expect(stamped.map((e) => e.tick)).toEqual([42, 42])
    expect(queue.pendingCount).toBe(0)
    expect(queue.take(43).length).toBe(0)
    expect(queue.recorded().length).toBe(2)
  })

  test("refuses an input the manifest does not declare, where it is pushed", () => {
    // A misspelt name in a game's page is found while its author plays, not
    // when a server throws the run away.
    const queue = new LiveInputQueue(INPUTS)
    expect(() => queue.push({ code: "jmup", value: 1 })).toThrow(
      /E_INPUT_UNDECLARED/,
    )
    expect(() => queue.push({ code: "toString", value: 1 })).toThrow(
      /E_INPUT_UNDECLARED/,
    )
  })

  test("refuses a value outside its declared range, and a fraction", () => {
    const queue = new LiveInputQueue(INPUTS)
    expect(() => queue.push({ code: "steer", value: 11 })).toThrow(
      /E_INPUT_UNDECLARED/,
    )
    expect(() => queue.push({ code: "steer", value: 0.7 })).toThrow(
      /E_INPUT_RANGE/,
    )
  })

  test("turns -0 into 0", () => {
    const queue = new LiveInputQueue(INPUTS)
    queue.push({ code: "steer", value: -0 })
    expect(Object.is(queue.take(0)[0]?.value, 0)).toBe(true)
  })

  test("a level merged as latest keeps the last value, where the first stood", () => {
    // In place, so a pointer's position recorded before its press stays
    // before it, and the tick holds one value per level.
    const queue = new LiveInputQueue(INPUTS)
    queue.push({ code: "aimX", value: 10, merge: "latest" })
    queue.push({ code: "aimY", value: 15, merge: "latest" })
    queue.push({ code: "tap", value: 1 })
    queue.push({ code: "aimX", value: 11, merge: "latest" })
    queue.push({ code: "aimY", value: 16, merge: "latest" })
    expect(taken(queue)).toEqual([
      ["aimX", 11],
      ["aimY", 16],
      ["tap", 1],
    ])
    // And it never reaches across ticks.
    queue.push({ code: "aimX", value: 12, merge: "latest" })
    expect(taken(queue, 1)).toEqual([["aimX", 12]])
  })

  test("an amount merged as sum is added up, and a sum of nothing is dropped", () => {
    const queue = new LiveInputQueue(INPUTS)
    queue.push({ code: "zoom", value: 2, merge: "sum" })
    queue.push({ code: "zoom", value: 3, merge: "sum" })
    expect(taken(queue)).toEqual([["zoom", 5]])
    queue.push({ code: "zoom", value: 2, merge: "sum" })
    queue.push({ code: "zoom", value: -2, merge: "sum" })
    queue.push({ code: "zoom", value: 0, merge: "sum" })
    expect(queue.take(1)).toEqual([])
  })

  test("a sum past its range is clamped, and the excess carried, up to one range", () => {
    // A flick faster than the game declared it could record is recorded at
    // the most it can carry, never refused.
    const queue = new LiveInputQueue(INPUTS)
    queue.push({ code: "zoom", value: 4, merge: "sum" })
    queue.push({ code: "zoom", value: 4, merge: "sum" })
    expect(taken(queue)).toEqual([["zoom", 5]])
    expect(taken(queue, 1)).toEqual([["zoom", 3]])
    expect(queue.take(2)).toEqual([])
    // Past one range's width, the rest is dropped.
    queue.push({ code: "zoom", value: 99, merge: "sum" })
    expect(taken(queue, 3)).toEqual([["zoom", 5]])
    expect(taken(queue, 4)).toEqual([["zoom", 5]])
    expect(taken(queue, 5)).toEqual([["zoom", 5]])
    expect(queue.take(6)).toEqual([])
  })

  test("presses are never merged", () => {
    const queue = new LiveInputQueue(INPUTS)
    queue.push({ code: "tap", value: 1 })
    queue.push({ code: "tap", value: 0 })
    queue.push({ code: "tap", value: 1 })
    expect(taken(queue)).toEqual([
      ["tap", 1],
      ["tap", 0],
      ["tap", 1],
    ])
  })

  test("a poller runs on each poll until it is removed", () => {
    const queue = new LiveInputQueue(INPUTS)
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

  test("a pause lets go of what is held, then takes nothing until resume", () => {
    // A press while paused would land on the tick the run resumes at,
    // which is not when the player made it.
    const queue = new LiveInputQueue(INPUTS)
    const stop = queue.onPause(() => queue.push({ code: "left", value: 0 }))
    queue.pause()
    queue.pause()
    queue.push({ code: "right", value: 1 })
    expect(taken(queue)).toEqual([["left", 0]])
    queue.resume()
    queue.push({ code: "right", value: 1 })
    expect(taken(queue, 1)).toEqual([["right", 1]])
    stop()
    queue.pause()
    expect(queue.take(2)).toEqual([])
  })

  test("reset empties what is pending, what was recorded, and what was carried", () => {
    const queue = new LiveInputQueue(INPUTS)
    queue.push({ code: "zoom", value: 9, merge: "sum" })
    queue.take(0)
    queue.reset()
    expect(queue.recorded()).toEqual([])
    expect(queue.take(1)).toEqual([])
  })

  test("the log it builds validates", () => {
    const queue = new LiveInputQueue(INPUTS)
    for (let tick = 0; tick < 100; tick += 7) {
      queue.push({ code: "left", value: tick % 2 })
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
  test("a log of declared inputs within their ranges passes", () => {
    expect(() =>
      checkInputs(
        [
          event(0, "tap", 1),
          event(1, "aimX", 0),
          event(1, "aimX", 32),
          event(2, "steer", -10),
          event(3, "zoom", 5),
        ],
        INPUTS,
        { endTick: 3 },
      ),
    ).not.toThrow()
  })

  // Each is a log a page following the manifest could not have made.
  const REFUSED: readonly [string, InputEvent][] = [
    ["a name the manifest does not declare", event(0, "fly", 1)],
    ["a name inherited by every object", event(0, "constructor", 1)],
    ["a value past the top of its range", event(0, "aimX", 33)],
    ["a value below the bottom", event(0, "steer", -11)],
  ]
  for (const [name, input] of REFUSED) {
    test(`refuses ${name}`, () => {
      expect(() => checkInputs([input], INPUTS, { endTick: 0 })).toThrow(
        /E_INPUT_UNDECLARED/,
      )
    })
  }

  test("refuses more inputs in one tick than a person could make", () => {
    const flood = Array.from({ length: MAX_INPUTS_PER_TICK + 1 }, () =>
      event(5, "tap", 1),
    )
    expect(() => checkInputs(flood, INPUTS, { endTick: 10_000 })).toThrow(
      /E_INPUT_BUDGET@5/,
    )
    expect(() =>
      checkInputs(flood.slice(1), INPUTS, { endTick: 10_000 }),
    ).not.toThrow()
  })

  test("refuses a run holding more than its budget, however its ticks are spread", () => {
    const ticks = 100
    const budget = INPUT_BUDGET_PER_TICK * ticks
    const log = Array.from({ length: budget + 1 }, (_, i) =>
      event(i % ticks, "tap", 1),
    ).sort((a, b) => a.tick - b.tick)
    expect(() => checkInputs(log, INPUTS, { endTick: ticks - 1 })).toThrow(
      /E_INPUT_BUDGET/,
    )
    expect(() =>
      checkInputs(log.slice(1), INPUTS, { endTick: ticks - 1 }),
    ).not.toThrow()
  })

  test("checks the log's shape first", () => {
    expect(() =>
      checkInputs([event(5), event(4)], INPUTS, { endTick: 9 }),
    ).toThrow(/E_INPUT_UNSORTED/)
  })

  test("a chunk is held to the budget for the ticks it covers, and to its span", () => {
    // Checked as each chunk arrives, so a run cannot store more than its
    // budget before it is submitted.
    const span = { afterTick: 9, throughTick: 19 }
    const budget = INPUT_BUDGET_PER_TICK * 10
    const fits = Array.from({ length: budget }, () => event(15, "tap", 1))
    expect(() => checkInputSpan(fits, INPUTS, span)).not.toThrow()
    expect(() =>
      checkInputSpan([...fits, event(15, "tap", 1)], INPUTS, span),
    ).toThrow(/E_INPUT_BUDGET/)
    expect(() => checkInputSpan([event(9, "tap", 1)], INPUTS, span)).toThrow(
      /E_INPUT_RANGE/,
    )
    expect(() => checkInputSpan([event(20, "tap", 1)], INPUTS, span)).toThrow(
      /E_INPUT_RANGE/,
    )
    expect(() => checkInputSpan([event(12, "fly", 1)], INPUTS, span)).toThrow(
      /E_INPUT_UNDECLARED/,
    )
  })
})
