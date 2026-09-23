/**
 * __kernel_cos, from fdlibm k_cos.c. See NOTICE.
 *
 * Computes cos(x + y) for |x| <= pi/4.
 */

import { fromWords, getHighWord } from "../../bits.js"

const C1 = 4.16666666666666019037e-2
const C2 = -1.38888888888741095749e-3
const C3 = 2.48015872894767294178e-5
const C4 = -2.75573143513906633035e-7
const C5 = 2.0875723212981748279e-9
const C6 = -1.13596475577881948265e-11

const ONE = 1.0

export function kernelCos(x: number, y: number): number {
  const ix = getHighWord(x) & 0x7fffffff
  if (ix < 0x3e400000) {
    // |x| < 2^-27: cos(x) rounds to 1.
    if ((x | 0) === 0) return ONE
  }
  const z = x * x
  const r = z * (C1 + z * (C2 + z * (C3 + z * (C4 + z * (C5 + z * C6)))))
  if (ix < 0x3fd33333) {
    // |x| < 0.3
    return ONE - (0.5 * z - (z * r - x * y))
  }
  // Splitting 1 - z/2 into a head and a tail keeps the cancellation under
  // control for the larger part of the range.
  let qx: number
  if (ix > 0x3fe90000) {
    // |x| > 0.78125
    qx = 0.28125
  } else {
    qx = fromWords(ix - 0x00200000, 0) // x/4
  }
  const hz = 0.5 * z - qx
  const a = ONE - qx
  return a - (hz - (z * r - x * y))
}
