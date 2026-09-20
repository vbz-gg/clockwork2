/**
 * log, log2 and log10, from fdlibm e_log.c. See NOTICE.
 *
 * log2 and log10 are scaled forms of log rather than separate polynomial
 * families. They are here because a game reaching for `Math.log2` should find
 * something with the same name, and a scaled log is deterministic in exactly
 * the way `Math.log2` is not.
 */

import { getHighWord, getLowWord, setHighWord } from "../bits"

const TWO54 = 1.8014398509481984e16
const LN2_HI = 6.9314718036912381649e-1
const LN2_LO = 1.90821492927058770002e-10
const LG1 = 6.66666666666673513e-1
const LG2 = 3.999999999940941908e-1
const LG3 = 2.857142874366239149e-1
const LG4 = 2.222219843214978396e-1
const LG5 = 1.818357216161805012e-1
const LG6 = 1.531383769920937332e-1
const LG7 = 1.479819860511658591e-1

/** 1/ln(2) and 1/ln(10), to scale log into log2 and log10. */
const IVLN2 = 1.442695040888963387
const IVLN10 = 4.34294481903251816668e-1

export function log(x: number): number {
  let value = x
  let hx = getHighWord(value)
  const lx = getLowWord(value)

  let k = 0
  if (hx < 0x00100000) {
    // x < 2^-1022
    if (((hx & 0x7fffffff) | lx) === 0) return -TWO54 / 0 // log(+-0) = -Infinity
    if (hx < 0) return (value - value) / 0 // log of a negative is NaN
    k -= 54
    value *= TWO54 // scale a subnormal up
    hx = getHighWord(value)
  }
  if (hx >= 0x7ff00000) return value + value

  k += (hx >> 20) - 1023
  hx &= 0x000fffff
  const i = (hx + 0x95f64) & 0x100000
  value = setHighWord(value, hx | (i ^ 0x3ff00000)) // normalise to [1, 2) or [0.5, 1)
  k += i >> 20

  const f = value - 1.0
  const dk = k

  if ((0x000fffff & (2 + hx)) < 3) {
    // |f| < 2^-20: the series is two terms.
    if (f === 0) {
      if (k === 0) return 0
      return dk * LN2_HI + dk * LN2_LO
    }
    const r = f * f * (0.5 - 0.33333333333333333 * f)
    if (k === 0) return f - r
    return dk * LN2_HI - (r - dk * LN2_LO - f)
  }

  const s = f / (2.0 + f)
  const z = s * s
  const w = z * z
  const t1 = w * (LG2 + w * (LG4 + w * LG6))
  const t2 = z * (LG1 + w * (LG3 + w * (LG5 + w * LG7)))
  const r = t2 + t1
  const iTest = (hx - 0x6147a) | (0x6b851 - hx)

  if (iTest > 0) {
    const hfsq = 0.5 * f * f
    if (k === 0) return f - (hfsq - s * (hfsq + r))
    return dk * LN2_HI - (hfsq - (s * (hfsq + r) + dk * LN2_LO) - f)
  }
  if (k === 0) return f - s * (f - r)
  return dk * LN2_HI - (s * (f - r) - dk * LN2_LO - f)
}

export function log2(x: number): number {
  return log(x) * IVLN2
}

export function log10(x: number): number {
  return log(x) * IVLN10
}
