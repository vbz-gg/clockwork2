/**
 * atan, atan2, asin and acos, from fdlibm s_atan.c, e_atan2.c, e_asin.c and
 * e_acos.c. See NOTICE.
 */

import { getHighWord, getLowWord, setHighWord, setLowWord } from "../bits.js"
import { f64 } from "./helpers.js"

const ATANHI = new Float64Array([
  4.63647609000806093515e-1, // atan(0.5)
  7.85398163397448278999e-1, // atan(1)
  9.82793723247329054082e-1, // atan(1.5)
  1.570796326794896558, // atan(inf)
])
const ATANLO = new Float64Array([
  2.26987774529616870924e-17, 3.06161699786838301793e-17,
  1.39033110312309984516e-17, 6.12323399573676603587e-17,
])
const AT = new Float64Array([
  3.33333333333329318027e-1, -1.99999999998764832476e-1,
  1.42857142725034663711e-1, -1.1111110405462355788e-1,
  9.09088713343650656196e-2, -7.69187620504482999495e-2,
  6.66107313738753120669e-2, -5.83357013379057348645e-2,
  4.97687799461593236017e-2, -3.6531572744216915527e-2,
  1.62858201153657823623e-2,
])

const ONE = 1.0
const HUGE = 1e300
const TINY = 1e-300

export function atan(xIn: number): number {
  let x = xIn
  const hx = getHighWord(x)
  const ix = hx & 0x7fffffff
  let id: number

  if (ix >= 0x44100000) {
    // |x| >= 2^66: the answer is pi/2 to within a rounding error.
    const low = getLowWord(x)
    if (ix > 0x7ff00000 || (ix === 0x7ff00000 && low !== 0)) return x + x // NaN
    if (hx > 0) return f64(ATANHI, 3) + f64(ATANLO, 3)
    return -f64(ATANHI, 3) - f64(ATANLO, 3)
  }

  if (ix < 0x3fdc0000) {
    // |x| < 0.4375
    if (ix < 0x3e200000) {
      // |x| < 2^-29
      if (HUGE + x > ONE) return x
    }
    id = -1
  } else {
    x = Math.abs(x)
    if (ix < 0x3ff30000) {
      if (ix < 0x3fe60000) {
        // 7/16 <= |x| < 11/16
        id = 0
        x = (2.0 * x - ONE) / (2.0 + x)
      } else {
        // 11/16 <= |x| < 19/16
        id = 1
        x = (x - ONE) / (x + ONE)
      }
    } else if (ix < 0x40038000) {
      // |x| < 2.4375
      id = 2
      x = (x - 1.5) / (ONE + 1.5 * x)
    } else {
      // 2.4375 <= |x| < 2^66
      id = 3
      x = -1.0 / x
    }
  }

  const z = x * x
  const w = z * z
  const s1 =
    z *
    (f64(AT, 0) +
      w *
        (f64(AT, 2) +
          w *
            (f64(AT, 4) +
              w * (f64(AT, 6) + w * (f64(AT, 8) + w * f64(AT, 10))))))
  const s2 =
    w *
    (f64(AT, 1) +
      w * (f64(AT, 3) + w * (f64(AT, 5) + w * (f64(AT, 7) + w * f64(AT, 9)))))

  if (id < 0) return x - x * (s1 + s2)
  const z2 = f64(ATANHI, id) - (x * (s1 + s2) - f64(ATANLO, id) - x)
  return hx < 0 ? -z2 : z2
}

const PI_O_4 = 7.85398163397448279e-1
const PI_O_2 = 1.570796326794896558
const PI = 3.141592653589793116
const PI_LO = 1.2246467991473531772e-16

export function atan2(y: number, x: number): number {
  const hx = getHighWord(x)
  const lx = getLowWord(x)
  const ix = hx & 0x7fffffff
  const hy = getHighWord(y)
  const ly = getLowWord(y)
  const iy = hy & 0x7fffffff

  // fdlibm spells the NaN test in high and low words; Number.isNaN is exactly
  // specified and says the same thing.
  if (Number.isNaN(x) || Number.isNaN(y)) return x + y
  if (((hx - 0x3ff00000) | lx) === 0) return atan(y) // x == 1

  const m = ((hy >>> 31) & 1) | ((hx >> 30) & 2) // 2*sign(x) + sign(y)

  if ((iy | ly) === 0) {
    switch (m) {
      case 0:
      case 1:
        return y // atan(+-0, +anything)
      case 2:
        return PI + TINY // atan(+0, -anything)
      default:
        return -PI - TINY // atan(-0, -anything)
    }
  }
  if ((ix | lx) === 0) return hy < 0 ? -PI_O_2 - TINY : PI_O_2 + TINY

  if (ix === 0x7ff00000) {
    if (iy === 0x7ff00000) {
      switch (m) {
        case 0:
          return PI_O_4 + TINY
        case 1:
          return -PI_O_4 - TINY
        case 2:
          return 3.0 * PI_O_4 + TINY
        default:
          return -3.0 * PI_O_4 - TINY
      }
    }
    switch (m) {
      case 0:
        return 0
      case 1:
        return -0
      case 2:
        return PI + TINY
      default:
        return -PI - TINY
    }
  }
  if (iy === 0x7ff00000) return hy < 0 ? -PI_O_2 - TINY : PI_O_2 + TINY

  const k = (iy - ix) >> 20
  let z: number
  if (k > 60) {
    z = PI_O_2 + 0.5 * PI_LO // |y/x| > 2^60
  } else if (hx < 0 && k < -60) {
    z = 0.0 // |y|/x < -2^60
  } else {
    z = atan(Math.abs(y / x))
  }

  switch (m) {
    case 0:
      return z
    case 1:
      return setHighWord(z, getHighWord(z) ^ 0x80000000)
    case 2:
      return PI - (z - PI_LO)
    default:
      return z - PI_LO - PI
  }
}

const PIO2_HI = 1.570796326794896558
const PIO2_LO = 6.12323399573676603587e-17
const PIO4_HI = 7.85398163397448278999e-1
const PS0 = 1.66666666666666657415e-1
const PS1 = -3.25565818622400915405e-1
const PS2 = 2.01212532134862925881e-1
const PS3 = -4.00555345006794114027e-2
const PS4 = 7.91534994289814532176e-4
const PS5 = 3.4793310759602116757e-5
const QS1 = -2.40339491173441421878
const QS2 = 2.02094576023350569471
const QS3 = -6.8828397160545329303e-1
const QS4 = 7.70381505559019352791e-2

function rationalR(t: number): number {
  const p = t * (PS0 + t * (PS1 + t * (PS2 + t * (PS3 + t * (PS4 + t * PS5)))))
  const q = ONE + t * (QS1 + t * (QS2 + t * (QS3 + t * QS4)))
  return p / q
}

export function asin(x: number): number {
  const hx = getHighWord(x)
  const ix = hx & 0x7fffffff

  if (ix >= 0x3ff00000) {
    const lx = getLowWord(x)
    if (((ix - 0x3ff00000) | lx) === 0) return x * PIO2_HI + x * PIO2_LO // +-1
    return (x - x) / (x - x) // |x| > 1
  }

  if (ix < 0x3fe00000) {
    // |x| < 0.5
    if (ix < 0x3e400000) {
      if (HUGE + x > ONE) return x // |x| < 2^-27
    }
    const t = x * x
    return x + x * rationalR(t)
  }

  // 0.5 <= |x| < 1
  const w = ONE - Math.abs(x)
  const t = w * 0.5
  const s = Math.sqrt(t)
  let result: number
  if (ix >= 0x3fef3333) {
    // |x| > 0.975
    result = PIO2_HI - (2.0 * (s + s * rationalR(t)) - PIO2_LO)
  } else {
    const df = setLowWord(s, 0)
    const c = (t - df * df) / (s + df)
    const p = 2.0 * s * rationalR(t) - (PIO2_LO - 2.0 * c)
    const q = PIO4_HI - 2.0 * df
    result = PIO4_HI - (p - q)
  }
  return hx > 0 ? result : -result
}

export function acos(x: number): number {
  const hx = getHighWord(x)
  const ix = hx & 0x7fffffff

  if (ix >= 0x3ff00000) {
    const lx = getLowWord(x)
    if (((ix - 0x3ff00000) | lx) === 0) {
      if (hx > 0) return 0.0
      return PI + 2.0 * PIO2_LO
    }
    return (x - x) / (x - x) // |x| > 1
  }

  if (ix < 0x3fe00000) {
    // |x| < 0.5
    if (ix <= 0x3c600000) return PIO2_HI + PIO2_LO // |x| < 2^-57
    const z = x * x
    return PIO2_HI - (x - (PIO2_LO - x * rationalR(z)))
  }

  if (hx < 0) {
    // x < -0.5
    const z = (ONE + x) * 0.5
    const s = Math.sqrt(z)
    const w = rationalR(z) * s - PIO2_LO
    return PI - 2.0 * (s + w)
  }

  // x > 0.5
  const z = (ONE - x) * 0.5
  const s = Math.sqrt(z)
  const df = setLowWord(s, 0)
  const c = (z - df * df) / (s + df)
  const w = rationalR(z) * s + c
  return 2.0 * (df + w)
}
