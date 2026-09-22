import { describe, expect, test } from "bun:test"
import {
  addToHighWord,
  fromBits,
  fromBitsHex,
  fromWords,
  getHighWord,
  getLowWord,
  HI,
  LO,
  nextDown,
  nextUp,
  setHighWord,
  setLowWord,
  toBits,
  toBitsHex,
  ulpDistance,
} from "../../src/bits"

describe("double bit access", () => {
  test("the word layout was detected, not assumed", () => {
    expect(HI === 0 || HI === 1).toBe(true)
    expect(LO).toBe(HI === 1 ? 0 : 1)
    expect(getHighWord(1)).toBe(0x3ff00000)
    expect(getLowWord(1)).toBe(0)
  })

  test("the high word is signed, so a sign test reads true", () => {
    // Getting this wrong is silent: every `hx < 0` in an fdlibm transcription
    // reads false and the routine returns a plausible wrong answer.
    expect(getHighWord(-1) < 0).toBe(true)
    expect(getHighWord(-0) < 0).toBe(true)
    expect(getHighWord(1) > 0).toBe(true)
    expect(getHighWord(0)).toBe(0)
  })

  test("words round trip", () => {
    for (const x of [1, -1, 0.1, -0.1, 1e300, 1e-300, Number.MIN_VALUE]) {
      expect(fromWords(getHighWord(x), getLowWord(x))).toBe(x)
    }
  })

  test("setHighWord and setLowWord leave the other half alone", () => {
    expect(getLowWord(setHighWord(0.1, getHighWord(0.2)))).toBe(getLowWord(0.1))
    expect(getHighWord(setLowWord(0.1, 7))).toBe(getHighWord(0.1))
    expect(getLowWord(setLowWord(0.1, 7))).toBe(7)
  })

  test("addToHighWord shifts the exponent", () => {
    expect(addToHighWord(1, 1 << 20)).toBe(2)
    expect(addToHighWord(1, -(1 << 20))).toBe(0.5)
  })

  test("bit patterns round trip through hex", () => {
    for (const x of [0, -0, 1, -1, Number.NaN, Number.POSITIVE_INFINITY, 0.1]) {
      const hex = toBitsHex(x)
      expect(hex).toMatch(/^[0-9A-F]{16}$/)
      expect(toBitsHex(fromBitsHex(hex))).toBe(hex)
    }
    expect(toBitsHex(-0)).toBe("8000000000000000")
    expect(toBitsHex(0)).toBe("0000000000000000")
    expect(fromBits(toBits(0.1))).toBe(0.1)
  })

  test("nextUp and nextDown step exactly one representable value", () => {
    expect(nextUp(1)).toBe(1 + Number.EPSILON)
    expect(nextDown(1)).toBe(1 - Number.EPSILON / 2)
    expect(nextUp(0)).toBe(Number.MIN_VALUE)
    expect(nextDown(0)).toBe(-Number.MIN_VALUE)
    expect(nextUp(-Number.MIN_VALUE)).toBe(-0)
    expect(nextDown(Number.MIN_VALUE)).toBe(0)
    expect(nextUp(Number.POSITIVE_INFINITY)).toBe(Number.POSITIVE_INFINITY)
    expect(Number.isNaN(nextUp(Number.NaN))).toBe(true)
  })

  test("ulpDistance counts representable values", () => {
    expect(ulpDistance(1, 1)).toBe(0n)
    expect(ulpDistance(1, nextUp(1))).toBe(1n)
    expect(ulpDistance(nextUp(1), 1)).toBe(1n)
    expect(ulpDistance(-0, 0)).toBe(0n)
    expect(ulpDistance(-Number.MIN_VALUE, Number.MIN_VALUE)).toBe(2n)
    expect(ulpDistance(Number.NaN, Number.NaN)).toBe(0n)
    expect(ulpDistance(Number.NaN, 1)).toBe(-1n)
  })
})
