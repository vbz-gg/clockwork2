/**
 * __ieee754_rem_pio2, from fdlibm e_rem_pio2.c. See NOTICE.
 *
 * Reduces x to r + tail with |r| <= pi/4, returning n such that
 * x = n*(pi/2) + r + tail. Everything downstream of it - sin, cos, tan - is a
 * polynomial on that reduced value, so this is where the accuracy of the whole
 * trigonometric family is decided.
 */

import { fromWords, getHighWord, getLowWord } from "../../bits"
import {
  HW_3PI_4,
  HW_PI_2,
  HW_PI_4,
  HW_REM_PIO2_MEDIUM_MAX,
  INVPIO2,
  PIO2_1,
  PIO2_1T,
  PIO2_2,
  PIO2_2T,
  PIO2_3,
  PIO2_3T,
  TWO24,
} from "../constants"
import { i32 } from "../helpers"
import { kernelRemPio2 } from "./rem-pio2-large"

/** High words of n*(pi/2) for n = 1..32, where the split needs extra care. */
const NPIO2_HW = new Int32Array([
  0x3ff921fb, 0x400921fb, 0x4012d97c, 0x401921fb, 0x401f6a7a, 0x4022d97c,
  0x4025fdbb, 0x402921fb, 0x402c463a, 0x402f6a7a, 0x4031475c, 0x4032d97c,
  0x40346b9c, 0x4035fdbb, 0x40378fdb, 0x403921fb, 0x403ab41b, 0x403c463a,
  0x403dd85a, 0x403f6a7a, 0x40407e4c, 0x4041475c, 0x4042106c, 0x4042d97c,
  0x4043a28c, 0x40446b9c, 0x404534ac, 0x4045fdbb, 0x4046c6cb, 0x40478fdb,
  0x404858eb, 0x404921fb,
])

const HALF = 0.5

const scratchTx = new Float64Array(3)

/**
 * @param x the value to reduce
 * @param y a two-element scratch array the head and tail are written into
 * @returns n, so that x = n*(pi/2) + y[0] + y[1]
 */
export function remPio2(x: number, y: Float64Array): number {
  const hx = getHighWord(x)
  const ix = hx & 0x7fffffff

  if (ix <= HW_PI_4) {
    // |x| <= pi/4: nothing to do.
    y[0] = x
    y[1] = 0
    return 0
  }

  if (ix < HW_3PI_4) {
    // |x| < 3pi/4: one step of pi/2.
    if (hx > 0) {
      let z = x - PIO2_1
      if (ix !== HW_PI_2) {
        y[0] = z - PIO2_1T
        y[1] = z - (y[0] as number) - PIO2_1T
      } else {
        z -= PIO2_2
        y[0] = z - PIO2_2T
        y[1] = z - (y[0] as number) - PIO2_2T
      }
      return 1
    }
    let z = x + PIO2_1
    if (ix !== HW_PI_2) {
      y[0] = z + PIO2_1T
      y[1] = z - (y[0] as number) + PIO2_1T
    } else {
      z += PIO2_2
      y[0] = z + PIO2_2T
      y[1] = z - (y[0] as number) + PIO2_2T
    }
    return -1
  }

  if (ix <= HW_REM_PIO2_MEDIUM_MAX) {
    // |x| <= 2^19 * (pi/2): Cody-Waite, escalating the split of pi/2 when the
    // subtraction cancels enough digits to need it.
    const t = Math.abs(x)
    const n = Math.trunc(t * INVPIO2 + HALF)
    const fn = n
    let r = t - fn * PIO2_1
    let w = fn * PIO2_1T
    if (n < 32 && ix !== i32(NPIO2_HW, n - 1)) {
      y[0] = r - w
    } else {
      const j = ix >> 20
      y[0] = r - w
      let high = getHighWord(y[0] as number)
      let i = j - ((high >> 20) & 0x7ff)
      if (i > 16) {
        // Cancellation ate more than 16 bits; go to 33+33+53.
        const t2 = r
        w = fn * PIO2_2
        r = t2 - w
        w = fn * PIO2_2T - (t2 - r - w)
        y[0] = r - w
        high = getHighWord(y[0] as number)
        i = j - ((high >> 20) & 0x7ff)
        if (i > 49) {
          // And again, to 33+33+33+53.
          const t3 = r
          w = fn * PIO2_3
          r = t3 - w
          w = fn * PIO2_3T - (t3 - r - w)
          y[0] = r - w
        }
      }
    }
    y[1] = r - (y[0] as number) - w
    if (hx < 0) {
      y[0] = -(y[0] as number)
      y[1] = -(y[1] as number)
      return -n
    }
    return n
  }

  if (ix >= 0x7ff00000) {
    // Infinity or NaN: there is no reduction, and NaN must propagate.
    y[0] = x - x
    y[1] = y[0] as number
    return 0
  }

  // Payne-Hanek. Split |x| into three 24-bit pieces first.
  const low = getLowWord(x)
  const e0 = (ix >> 20) - 1046 // ilogb(z) - 23
  let z = fromWords(ix - (e0 << 20), low)
  for (let i = 0; i < 2; i++) {
    scratchTx[i] = Math.trunc(z)
    z = (z - (scratchTx[i] as number)) * TWO24
  }
  scratchTx[2] = z
  let nx = 3
  while ((scratchTx[nx - 1] as number) === 0) nx--

  const n = kernelRemPio2(scratchTx, y, e0, nx, 2)
  if (hx < 0) {
    y[0] = -(y[0] as number)
    y[1] = -(y[1] as number)
    return -n
  }
  return n
}
