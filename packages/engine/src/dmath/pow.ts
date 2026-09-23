/**
 * pow and ipow, from fdlibm e_pow.c. See NOTICE.
 *
 * One deliberate divergence from the C. fdlibm follows C99 and returns 1 for
 * `pow(+-1, +-Infinity)`; ECMAScript specifies NaN. Since this function exists
 * to be reached for in place of `Math.pow`, it follows ECMAScript on every
 * case ECMAScript actually specifies, and fdlibm only where the standard
 * leaves the result to the implementation. The case is handled before the
 * transcribed body so the body stays recognisable against the reference.
 *
 * Prefer `ipow` where the exponent is a whole number. It is exact, it is far
 * cheaper, and it never reaches any of this.
 */

import { getHighWord, getLowWord, setHighWord, setLowWord } from "../bits.js"
import { fail } from "../errors.js"
import { HUGE, TINY, TWO53 } from "./constants.js"
import { scalbn } from "./helpers.js"

const ZERO = 0.0
const ONE = 1.0
const TWO = 2.0

const BP0 = 1.0
const BP1 = 1.5
const DP_H1 = 5.84962487220764160156e-1
const DP_L1 = 1.35003920212974897128e-8

const L1 = 5.99999999999994648725e-1
const L2 = 4.28571428578550184252e-1
const L3 = 3.33333329818377432918e-1
const L4 = 2.72728123808534006489e-1
const L5 = 2.30660745775561754067e-1
const L6 = 2.06975017800338417784e-1
const P1 = 1.66666666666666019037e-1
const P2 = -2.77777777770155933842e-3
const P3 = 6.61375632143793436117e-5
const P4 = -1.6533902205465251539e-6
const P5 = 4.13813679705723846039e-8
const LG2 = 6.93147180559945286227e-1
const LG2_H = 6.93147182464599609375e-1
const LG2_L = -1.90465429995776804525e-9
const OVT = 8.0085662595372944372e-17
const CP = 9.61796693925975554329e-1
const CP_H = 9.61796700954437255859e-1
const CP_L = -7.02846165095275826516e-9
const IVLN2 = 1.442695040888963387
const IVLN2_H = 1.44269502162933349609
const IVLN2_L = 1.92596299112661746887e-8

export function pow(x: number, y: number): number {
  const hx = getHighWord(x)
  const lx = getLowWord(x) >>> 0
  const hy = getHighWord(y)
  const ly = getLowWord(y) >>> 0
  let ix = hx & 0x7fffffff
  const iy = hy & 0x7fffffff

  // y == 0, including NaN ** 0.
  if ((iy | ly) === 0) return ONE

  // Either argument NaN.
  if (
    ix > 0x7ff00000 ||
    (ix === 0x7ff00000 && lx !== 0) ||
    iy > 0x7ff00000 ||
    (iy === 0x7ff00000 && ly !== 0)
  ) {
    return x + y
  }

  // ECMAScript, not C99: |x| == 1 with an infinite exponent is NaN.
  if (iy === 0x7ff00000 && ly === 0 && ix === 0x3ff00000 && lx === 0) {
    return Number.NaN
  }

  // Is y an integer, and if so an odd one? 0 no, 1 odd, 2 even.
  let yisint = 0
  if (hx < 0) {
    if (iy >= 0x43400000) {
      yisint = 2 // too large to be anything but even
    } else if (iy >= 0x3ff00000) {
      const k = (iy >> 20) - 0x3ff
      if (k > 20) {
        const j = ly >>> (52 - k)
        if ((j << (52 - k)) >>> 0 === ly) yisint = 2 - (j & 1)
      } else if (ly === 0) {
        const j = iy >> (20 - k)
        if (j << (20 - k) === iy) yisint = 2 - (j & 1)
      }
    }
  }

  if (ly === 0) {
    if (iy === 0x7ff00000) {
      // |x| != 1 here, that case returned above.
      if (ix >= 0x3ff00000) return hy >= 0 ? y : ZERO
      return hy < 0 ? -y : ZERO
    }
    if (iy === 0x3ff00000) return hy < 0 ? ONE / x : x
    if (hy === 0x40000000) return x * x
    if (hy === 0x3fe00000 && hx >= 0) return Math.sqrt(x)
  }

  let ax = Math.abs(x)

  if (lx === 0) {
    if (ix === 0x7ff00000 || ix === 0 || ix === 0x3ff00000) {
      // x is +-0, +-Infinity or +-1
      let z = ax
      if (hy < 0) z = ONE / z
      if (hx < 0) {
        if (((ix - 0x3ff00000) | yisint) === 0) {
          z = (z - z) / (z - z) // (-1) ** non-integer
        } else if (yisint === 1) {
          z = -z
        }
      }
      return z
    }
  }

  const n0 = (hx >>> 31) - 1
  if ((n0 | yisint) === 0) return (x - x) / (x - x) // negative base, non-integer exponent

  let s = ONE
  if ((n0 | (yisint - 1)) === 0) s = -ONE // negative base, odd integer exponent

  let t1: number
  let t2: number

  if (iy > 0x41e00000) {
    // |y| > 2^31
    if (iy > 0x43f00000) {
      if (ix <= 0x3fefffff) return hy < 0 ? HUGE * HUGE : TINY * TINY
      if (ix >= 0x3ff00000) return hy > 0 ? HUGE * HUGE : TINY * TINY
    }
    if (ix < 0x3fefffff) return hy < 0 ? s * HUGE * HUGE : s * TINY * TINY
    if (ix > 0x3ff00000) return hy > 0 ? s * HUGE * HUGE : s * TINY * TINY
    // |1-x| is tiny, so log(x) is its first few terms.
    const t = ax - ONE
    const w = t * t * (0.5 - t * (0.3333333333333333333333 - t * 0.25))
    const u = IVLN2_H * t
    const v = t * IVLN2_L - w * IVLN2
    t1 = setLowWord(u + v, 0)
    t2 = v - (t1 - u)
  } else {
    let n = 0
    if (ix < 0x00100000) {
      // subnormal x
      ax *= TWO53
      n -= 53
      ix = getHighWord(ax)
    }
    n += (ix >> 20) - 0x3ff
    const j = ix & 0x000fffff
    ix = j | 0x3ff00000 // normalise into [1, 2)
    let k: number
    if (j <= 0x3988e) {
      k = 0 // |x| < sqrt(3/2)
    } else if (j < 0xbb67a) {
      k = 1 // |x| < sqrt(3)
    } else {
      k = 0
      n += 1
      ix -= 0x00100000
    }
    ax = setHighWord(ax, ix)

    const bp = k === 0 ? BP0 : BP1
    const u = ax - bp
    const v = ONE / (ax + bp)
    const ss = u * v
    const sH = setLowWord(ss, 0)
    let tH = setHighWord(
      ZERO,
      ((ix >> 1) | 0x20000000) + 0x00080000 + (k << 18),
    )
    let tL = ax - (tH - bp)
    const sL = v * (u - sH * tH - sH * tL)

    let s2 = ss * ss
    let r =
      s2 * s2 * (L1 + s2 * (L2 + s2 * (L3 + s2 * (L4 + s2 * (L5 + s2 * L6)))))
    r += sL * (sH + ss)
    s2 = sH * sH
    tH = setLowWord(3.0 + s2 + r, 0)
    tL = r - (tH - 3.0 - s2)

    const u2 = sH * tH
    const v2 = sL * tH + tL * ss
    const logH = setLowWord(u2 + v2, 0)
    const logL = v2 - (logH - u2)
    const zH = CP_H * logH
    const zL = CP_L * logH + logL * CP + (k === 0 ? 0 : DP_L1)
    const t = n
    t1 = setLowWord(zH + zL + (k === 0 ? 0 : DP_H1) + t, 0)
    t2 = zL - (t1 - t - (k === 0 ? 0 : DP_H1) - zH)
  }

  // (y1 + y2) * (t1 + t2)
  const y1 = setLowWord(y, 0)
  const pL = (y - y1) * t1 + y * t2
  let pH = y1 * t1
  let z = pL + pH
  let j = getHighWord(z)
  const i = getLowWord(z) >>> 0

  if (j >= 0x40900000) {
    // z >= 1024
    if (((j - 0x40900000) | i) !== 0) return s * HUGE * HUGE
    if (pL + OVT > z - pH) return s * HUGE * HUGE
  } else if ((j & 0x7fffffff) >= 0x4090cc00) {
    // z <= -1075
    if (((j - 0xc090cc00) | 0 | i) !== 0) return s * TINY * TINY
    if (pL <= z - pH) return s * TINY * TINY
  }

  // 2 ** (pH + pL)
  const iAbs = j & 0x7fffffff
  let k2 = (iAbs >> 20) - 0x3ff
  let n2 = 0
  if (iAbs > 0x3fe00000) {
    n2 = j + (0x00100000 >> (k2 + 1))
    k2 = ((n2 & 0x7fffffff) >> 20) - 0x3ff
    const t = setHighWord(ZERO, n2 & ~(0x000fffff >> k2))
    n2 = ((n2 & 0x000fffff) | 0x00100000) >> (20 - k2)
    if (j < 0) n2 = -n2
    pH -= t
  }
  const t = setLowWord(pL + pH, 0)
  const u = t * LG2_H
  const v = (pL - (t - pH)) * LG2 + t * LG2_L
  z = u + v
  const w = v - (z - u)
  const zz = z * z
  const tt = z - zz * (P1 + zz * (P2 + zz * (P3 + zz * (P4 + zz * P5))))
  const r = (z * tt) / (tt - TWO) - (w + z * w)
  z = ONE - (r - z)
  j = getHighWord(z)
  j += n2 << 20
  if (j >> 20 <= 0) {
    z = scalbn(z, n2) // subnormal result
  } else {
    z = setHighWord(z, j)
  }
  return s * z
}

/**
 * x raised to a whole-number power, by squaring.
 *
 * Exact, because it is nothing but multiplication, and much cheaper than
 * `pow`. Almost every use of `**` in game code is this, so reach for it first.
 */
export function ipow(x: number, n: number): number {
  if (!Number.isSafeInteger(n)) {
    fail("E_DMATH_RANGE", {
      detail: `ipow() needs a whole-number exponent, got ${n}`,
    })
  }
  if (n === 0) return 1
  let exponent = n < 0 ? -n : n
  let base = x
  let result = 1
  while (exponent > 0) {
    if ((exponent & 1) === 1) result *= base
    base *= base
    exponent >>>= 1
  }
  return n < 0 ? 1 / result : result
}
