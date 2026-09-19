/**
 * exp, from fdlibm e_exp.c. See NOTICE.
 *
 * Note for anyone comparing against a host `Math.exp`: netlib fdlibm returns
 * 0x4005BF0A8B14576A for exp(1) where V8 and JavaScriptCore both return the
 * correctly rounded 0x4005BF0A8B145769. That one-ulp difference is fdlibm's,
 * it is reproducible, and it is recorded in the oracle test's exception list
 * rather than patched out - a local fix would be a divergence from the
 * reference this file is checked against.
 */

import { getHighWord, getLowWord, setHighWord } from "../bits"

const ONE = 1.0
const HALF_POS = 0.5
const HALF_NEG = -0.5
const HUGE = 1e300
const TWOM1000 = 9.3326361850321887899e-302
const O_THRESHOLD = 7.09782712893383973096e2
const U_THRESHOLD = -7.4513321910194110842e2
const LN2HI_POS = 6.9314718036912381649e-1
const LN2HI_NEG = -6.9314718036912381649e-1
const LN2LO_POS = 1.90821492927058770002e-10
const LN2LO_NEG = -1.90821492927058770002e-10
const INVLN2 = 1.442695040888963387
const P1 = 1.66666666666666019037e-1
const P2 = -2.77777777770155933842e-3
const P3 = 6.61375632143793436117e-5
const P4 = -1.6533902205465251539e-6
const P5 = 4.13813679705723846039e-8

export function exp(x: number): number {
  let value = x
  let hx = getHighWord(value)
  const xsb = (hx >>> 31) & 1 // sign bit
  hx &= 0x7fffffff

  if (hx >= 0x40862e42) {
    // |x| >= 709.78...
    if (hx >= 0x7ff00000) {
      const lx = getLowWord(value)
      if (((hx & 0xfffff) | lx) !== 0) return value + value // NaN
      return xsb === 0 ? value : 0.0 // exp(+-inf)
    }
    if (value > O_THRESHOLD) return HUGE * HUGE // overflow
    if (value < U_THRESHOLD) return TWOM1000 * TWOM1000 // underflow
  }

  let k = 0
  let hi = 0
  let lo = 0
  if (hx > 0x3fd62e42) {
    // |x| > 0.5 ln2
    if (hx < 0x3ff0a2b2) {
      // |x| < 1.5 ln2
      hi = value - (xsb === 0 ? LN2HI_POS : LN2HI_NEG)
      lo = xsb === 0 ? LN2LO_POS : LN2LO_NEG
      k = 1 - xsb - xsb
    } else {
      k = Math.trunc(INVLN2 * value + (xsb === 0 ? HALF_POS : HALF_NEG))
      const t = k
      hi = value - t * LN2HI_POS // exact, because ln2HI has trailing zeros
      lo = t * LN2LO_POS
    }
    value = hi - lo
  } else if (hx < 0x3e300000) {
    // |x| < 2^-28: exp(x) rounds to 1 + x
    if (HUGE + value > ONE) return ONE + value
  }

  const t = value * value
  const c = value - t * (P1 + t * (P2 + t * (P3 + t * (P4 + t * P5))))
  if (k === 0) return ONE - ((value * c) / (c - 2.0) - value)

  const y = ONE - (lo - (value * c) / (2.0 - c) - hi)
  const hy = getHighWord(y)
  if (k >= -1021) return setHighWord(y, hy + (k << 20))
  return setHighWord(y, hy + ((k + 1000) << 20)) * TWOM1000
}
