/**
 * Small pieces the fdlibm transcriptions share.
 *
 * `f64` and `i32` exist because `noUncheckedIndexedAccess` types a typed-array
 * read as `number | undefined`. Reading a table through them keeps the
 * polynomial code readable and costs nothing at run time.
 */

import { fromWords, getHighWord, setHighWord } from "../bits.js"
import { fail } from "../errors.js"

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

/**
 * `x` with the sign of `y`. Refuses a NaN in either argument with
 * `E_ARG_INVALID`.
 *
 * The refusal is not in fdlibm's C, and the departure is
 * deliberate. A NaN's sign bit is chosen by the processor rather than by
 * ECMAScript: an invalid operation yields `0xFFF8000000000000` on x86 and
 * `0x7FF8000000000000` on arm64. Every other route from a NaN to a score is
 * already closed, because `hashCanonical` refuses one, a counter must be a
 * whole number, and `JSON.stringify(NaN)` is `null`. `copysign` was the way
 * through all three: it reads that architecture-dependent bit and returns a
 * *finite* number, so `copysign(5, inf - inf)` is `-5` on x86 and `5` on
 * arm64, and the hash takes both. Two players would then reach different
 * checkpoints on the same inputs and the replay would report a mismatch
 * neither of them caused.
 *
 * A NaN in `x` cannot leak that way, since the result is still a NaN and the
 * encoder refuses it. It is refused anyway, so the rule is "copysign refuses a
 * NaN" rather than a rule about one argument, and so a simulation that has
 * produced a NaN hears about it at the line that used it instead of at the
 * next hash.
 *
 * `scalbn` is unaffected: it returns early on a NaN or an infinity, so the
 * value it passes here is always finite.
 */
export function copysign(x: number, y: number): number {
  if (Number.isNaN(x) || Number.isNaN(y)) {
    fail("E_ARG_INVALID", {
      detail: `copysign(${x}, ${y}): a NaN's sign bit is decided by the processor, so copysign would turn it into an architecture-dependent finite number`,
    })
  }
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
