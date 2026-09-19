/**
 * Small pieces the fdlibm transcriptions share.
 *
 * `f64` and `i32` exist because `noUncheckedIndexedAccess` types a typed-array
 * read as `number | undefined`. Reading a table through them keeps the
 * polynomial code readable and costs nothing at run time.
 */

import { fromWords, getHighWord, setHighWord } from "../bits"

export function f64(table: Float64Array, index: number): number {
  return table[index] as number
}

export function i32(table: Int32Array, index: number): number {
  return table[index] as number
}

/** 2^k as an exact double, for -1022 <= k <= 1023. No call to pow. */
export function twoPow(k: number): number {
  return fromWords((k + 1023) << 20, 0)
}

const TWO54 = 1.8014398509481984e16 // 2^54
const TWOM54 = 5.551115123125783e-17 // 2^-54
const HUGE = 1e300
const TINY = 1e-300

export function copysign(x: number, y: number): number {
  const hx = getHighWord(x)
  const hy = getHighWord(y)
  return setHighWord(x, (hx & 0x7fffffff) | (hy & 0x80000000))
}

/**
 * x * 2^n, exactly. Transcribed from fdlibm s_scalbn.c, which handles
 * subnormal input and output by scaling in and out rather than by repeated
 * multiplication, so no intermediate rounding creeps in.
 */
export function scalbn(x: number, n: number): number {
  let value = x
  let hx = getHighWord(value)
  let k = (hx & 0x7ff00000) >> 20

  if (k === 0) {
    // Zero or subnormal.
    if (value === 0) return value
    value *= TWO54
    hx = getHighWord(value)
    k = ((hx & 0x7ff00000) >> 20) - 54
    if (n < -50000) return TINY * value
  }
  if (k === 0x7ff) return value + value // NaN or Infinity

  k = k + n
  if (k > 0x7fe) return HUGE * copysign(HUGE, value) // overflow
  if (k > 0) return setHighWord(value, (hx & 0x800fffff) | (k << 20))
  if (k <= -54) {
    if (n > 50000) return HUGE * copysign(HUGE, value) // overflow
    return TINY * copysign(TINY, value) // underflow
  }
  k += 54
  return setHighWord(value, (hx & 0x800fffff) | (k << 20)) * TWOM54
}
