/**
 * __kernel_tan, from fdlibm k_tan.c. See NOTICE.
 *
 * Computes tan(x + y) for |x| <= pi/4. `iy` is 1 for tan and -1 for cot, which
 * is how one routine serves both: the reduction hands it -1 when the result
 * has to be inverted.
 */

import { getHighWord, getLowWord, setLowWord } from "../../bits.js"
import { f64 } from "../helpers.js"

const T = new Float64Array([
  3.33333333333334091986e-1, 1.33333333333201242699e-1,
  5.39682539762260521377e-2, 2.18694882948595424599e-2,
  8.86323982359930005737e-3, 3.59207910759131235356e-3,
  1.45620945432529025516e-3, 5.88041240820264096874e-4,
  2.46463134818469906812e-4, 7.817944429395570923e-5, 7.14072491382608190305e-5,
  -1.85586374855275456654e-5, 2.59073051863633712884e-5,
])

const ONE = 1.0
const PIO4 = 7.85398163397448278999e-1
const PIO4LO = 3.06161699786838301793e-17

export function kernelTan(xIn: number, yIn: number, iy: number): number {
  let x = xIn
  let y = yIn
  const hx = getHighWord(x)
  const ix = hx & 0x7fffffff

  if (ix < 0x3e300000) {
    // |x| < 2^-28
    if ((x | 0) === 0) {
      const low = getLowWord(x)
      if ((ix | low | (iy + 1)) === 0) return ONE / Math.abs(x)
      if (iy === 1) return x
      // Compute -1/(x+y) carefully.
      const w0 = x + y
      const z0 = setLowWord(w0, 0)
      const v0 = y - (z0 - x)
      const a0 = -ONE / w0
      const t0 = setLowWord(a0, 0)
      const s0 = ONE + t0 * z0
      return t0 + a0 * (s0 + t0 * v0)
    }
  }

  if (ix >= 0x3fe59428) {
    // |x| >= 0.6744: tan(pi/4 - x) is better conditioned here.
    if (hx < 0) {
      x = -x
      y = -y
    }
    const z1 = PIO4 - x
    const w1 = PIO4LO - y
    x = z1 + w1
    y = 0.0
  }

  const z = x * x
  const w = z * z
  const rEven =
    f64(T, 1) +
    w *
      (f64(T, 3) +
        w * (f64(T, 5) + w * (f64(T, 7) + w * (f64(T, 9) + w * f64(T, 11)))))
  const v =
    z *
    (f64(T, 2) +
      w *
        (f64(T, 4) +
          w *
            (f64(T, 6) + w * (f64(T, 8) + w * (f64(T, 10) + w * f64(T, 12))))))
  const s = z * x
  let r = y + z * (s * (rEven + v) + y)
  r += f64(T, 0) * s
  const w2 = x + r

  if (ix >= 0x3fe59428) {
    const v2 = iy
    return (
      (1 - ((hx >> 30) & 2)) * (v2 - 2.0 * (x - ((w2 * w2) / (w2 + v2) - r)))
    )
  }
  if (iy === 1) return w2
  // Compute -1/(x+r) accurately.
  const z3 = setLowWord(w2, 0)
  const v3 = r - (z3 - x)
  const a3 = -1.0 / w2
  const t3 = setLowWord(a3, 0)
  const s3 = 1.0 + t3 * z3
  return t3 + a3 * (s3 + t3 * v3)
}
