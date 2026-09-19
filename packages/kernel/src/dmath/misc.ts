/**
 * The pieces that are not fdlibm transcriptions: hypot, angle wrapping, and
 * float32 helpers.
 */

import { fromWords, getHighWord } from "../bits"
import { PI, PI_2, TWO_PI } from "./constants"
import { remPio2 } from "./kernel/rem-pio2"

/**
 * sqrt(x*x + y*y), scaled so neither square overflows or underflows.
 *
 * Unlike the rest of this module this is not an fdlibm transcription, because
 * fdlibm's e_hypot spends a hundred lines reaching under one ulp and this
 * reaches one or two using nothing but exactly specified operations. It is
 * deterministic, which is what the simulation needs; `Math.hypot` is the worst
 * offender in the whole standard library, disagreeing between JavaScriptCore
 * and V8 on about a third of inputs.
 */
export function hypot(x: number, y: number): number {
  const ax = Math.abs(x)
  const ay = Math.abs(y)
  // Infinity wins over NaN here, which is what ECMAScript specifies.
  if (ax === Number.POSITIVE_INFINITY || ay === Number.POSITIVE_INFINITY) {
    return Number.POSITIVE_INFINITY
  }
  if (Number.isNaN(ax) || Number.isNaN(ay)) return Number.NaN
  const hi = ax > ay ? ax : ay
  const lo = ax > ay ? ay : ax
  if (hi === 0) return 0
  const r = lo / hi
  return hi * Math.sqrt(1 + r * r)
}

const scratch = new Float64Array(2)

/**
 * Brings an angle into [-pi, pi).
 *
 * Use it to stop an accumulating angle growing without bound, which keeps sin
 * and cos in their cheap path. It is accurate to a couple of ulp rather than
 * exact: the exact reduction is what `remPio2` does inside sin and cos, and
 * those do not need help.
 */
export function wrapAngle(x: number): number {
  if (!Number.isFinite(x)) return Number.NaN
  const n = remPio2(x, scratch)
  const r = (scratch[0] as number) + (scratch[1] as number)
  let quarter = n % 4
  if (quarter < 0) quarter += 4
  let angle = quarter * PI_2 + r
  if (angle >= PI) angle -= TWO_PI
  return angle
}

/**
 * Rounds to the nearest float32.
 *
 * `Math.fround` is exactly specified, so float32 storage is deterministic and
 * halves the bytes a snapshot has to hash. Add, subtract and multiply of two
 * float32 values are correctly rounded this way, because the double result of
 * the operation is exact before it is rounded once.
 *
 * Division is not: the double quotient is rounded, and then rounded again to
 * float32. That double rounding is still deterministic, which is all the
 * simulation requires, but it is not IEEE float32 division, so do not port a
 * shader here and expect the same bits.
 */
export const f32 = Math.fround

export function f32add(a: number, b: number): number {
  return Math.fround(a + b)
}

export function f32sub(a: number, b: number): number {
  return Math.fround(a - b)
}

export function f32mul(a: number, b: number): number {
  return Math.fround(a * b)
}

export function f32div(a: number, b: number): number {
  return Math.fround(a / b)
}

const F32_VIEW = new Float32Array(1)
const F32_BITS = new Uint32Array(F32_VIEW.buffer)

export function f32ToBits(x: number): number {
  F32_VIEW[0] = x
  return (F32_BITS[0] as number) >>> 0
}

export function f32FromBits(bits: number): number {
  F32_BITS[0] = bits >>> 0
  return F32_VIEW[0] as number
}

/** The sign of x applied to the magnitude of y, with -0 handled. */
export function sign(x: number): number {
  return Math.sign(x)
}

/** Exposed so a caller can build a power of two without reaching for pow. */
export function exp2i(k: number): number {
  if (!Number.isInteger(k) || k < -1022 || k > 1023) {
    throw new RangeError(`exp2i() takes an integer in [-1022, 1023], got ${k}`)
  }
  return fromWords((k + 1023) << 20, 0)
}

/** True when x is negative, including -0. Cheaper and clearer than comparing. */
export function isNegative(x: number): boolean {
  return getHighWord(x) < 0
}
