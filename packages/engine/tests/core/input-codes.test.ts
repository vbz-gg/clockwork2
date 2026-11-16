import { describe, expect, test } from "bun:test"
import {
  AXIS_UNITS,
  describeCode,
  devicesBound,
  maxOf,
  TILT_UNITS,
  valueFits,
} from "../../src/input-codes"
import { KEY_CODES } from "../../src/key-codes"

describe("the code table", () => {
  test("each kind of code names its device, kind and range", () => {
    expect(describeCode("ArrowLeft")).toEqual({
      device: "key",
      kind: "press",
      min: 0,
      max: 1,
    })
    expect(describeCode("pointer0")?.kind).toBe("press")
    expect(describeCode("pointer3-x")).toEqual({
      device: "pointer",
      kind: "level",
      min: 0,
      max: "width",
    })
    expect(describeCode("hover-y")?.max).toBe("height")
    expect(describeCode("pointer0-button2")?.kind).toBe("press")
    expect(describeCode("mouse-dx")?.kind).toBe("impulse")
    expect(describeCode("wheel-y")?.device).toBe("wheel")
    expect(describeCode("gamepad1-button7")?.kind).toBe("press")
    expect(describeCode("gamepad1-button7-value")).toEqual({
      device: "gamepad",
      kind: "level",
      min: 0,
      max: 100,
      rest: 0,
    })
    expect(describeCode("gamepad0-axis1")).toEqual({
      device: "gamepad",
      kind: "level",
      min: -AXIS_UNITS,
      max: AXIS_UNITS,
      rest: 0,
    })
    // Tilt has no rest: a phone put down is still tilted somewhere.
    expect(describeCode("tilt-z")).toEqual({
      device: "motion",
      kind: "level",
      min: -TILT_UNITS,
      max: TILT_UNITS,
    })
  })

  test("the edges of each numbered code are where the table says", () => {
    expect(describeCode("pointer9")).toBeDefined()
    expect(describeCode("pointer10")).toBeUndefined()
    expect(describeCode("pointer0-button4")).toBeDefined()
    expect(describeCode("pointer0-button5")).toBeUndefined()
    expect(describeCode("gamepad3-button31")).toBeDefined()
    expect(describeCode("gamepad4-button0")).toBeUndefined()
    expect(describeCode("gamepad0-button32")).toBeUndefined()
    expect(describeCode("gamepad0-axis15")).toBeDefined()
    expect(describeCode("gamepad0-axis16")).toBeUndefined()
    // A leading zero is a second spelling of one code, so it is not one.
    expect(describeCode("pointer01")).toBeUndefined()
    expect(describeCode("gamepad0-button07")).toBeUndefined()
  })

  test("a code no device sends is no code at all", () => {
    for (const code of [
      "",
      "Arrowleft",
      "Unidentified",
      "pointer",
      "pointer0-z",
      "virtual",
      "tilt-w",
      "wheel",
      "gamepad0-axis0-value",
    ]) {
      expect(describeCode(code)).toBeUndefined()
    }
  })

  test("the key list is the UI Events list, without Unidentified", () => {
    expect(KEY_CODES).toContain("KeyA")
    expect(KEY_CODES).toContain("NumpadEnter")
    expect(KEY_CODES).not.toContain("Unidentified")
    expect(new Set(KEY_CODES).size).toBe(KEY_CODES.length)
    expect([...KEY_CODES].sort()).toEqual([...KEY_CODES])
  })
})

describe("values", () => {
  const viewport = { width: 320, height: 480 }

  test("a coordinate's range is the viewport's", () => {
    const x = describeCode("pointer0-x")
    const y = describeCode("pointer0-y")
    if (x === undefined || y === undefined) throw new Error("no spec")
    expect(maxOf(x, viewport)).toBe(320)
    expect(maxOf(y, viewport)).toBe(480)
    expect(() => maxOf(x, undefined)).toThrow(/E_ARG_INVALID/)
  })

  test("a value fits only inside its range, and an impulse is never zero", () => {
    const press = describeCode("Space")
    const wheel = describeCode("wheel-y")
    const x = describeCode("pointer0-x")
    if (press === undefined || wheel === undefined || x === undefined) {
      throw new Error("no spec")
    }
    expect(valueFits(press, 1, undefined)).toBe(true)
    expect(valueFits(press, 2, undefined)).toBe(false)
    expect(valueFits(press, 0.5, undefined)).toBe(false)
    expect(valueFits(wheel, -4, undefined)).toBe(true)
    expect(valueFits(wheel, 0, undefined)).toBe(false)
    expect(valueFits(x, 320, viewport)).toBe(true)
    expect(valueFits(x, 321, viewport)).toBe(false)
  })
})

describe("the devices a game binds", () => {
  test("come from the codes, in the table's order, each once", () => {
    expect(
      devicesBound({
        map: {
          steer: [{ code: "tilt-x" }, { code: "ArrowLeft" }],
          tap: [{ code: "pointer0" }, { code: "pointer1" }],
          zoom: [{ code: "wheel-y" }],
        },
      }),
    ).toEqual(["key", "pointer", "motion", "wheel"])
  })

  test("a keyboard game binds no pointer, which is what a page warns a phone player about", () => {
    expect(devicesBound({ map: { jump: [{ code: "Space" }] } })).toEqual([
      "key",
    ])
  })
})
