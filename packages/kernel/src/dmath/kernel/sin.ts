/**
 * __kernel_sin, from fdlibm k_sin.c. See NOTICE.
 *
 * Computes sin(x + y) for |x| <= pi/4, where y is the tail of an argument
 * reduction. `iy` says whether y is used: 0 when the caller has none.
 */

import { getHighWord } from "../../bits"

const S1 = -1.66666666666666324348e-1
const S2 = 8.33333333332248946124e-3
const S3 = -1.98412698298579493134e-4
const S4 = 2.75573137070700676789e-6
const S5 = -2.50507602534068634195e-8
const S6 = 1.58969099521155010221e-10

const HALF = 0.5

export function kernelSin(x: number, y: number, iy: number): number {
  const ix = getHighWord(x) & 0x7fffffff
  if (ix < 0x3e400000) {
    // |x| < 2^-27: sin(x) is x to within a rounding error.
    if ((x | 0) === 0) return x
  }
  const z = x * x
  const v = z * x
  const r = S2 + z * (S3 + z * (S4 + z * (S5 + z * S6)))
  if (iy === 0) return x + v * (S1 + z * r)
  return x - (z * (HALF * y - v * r) - y - v * S1)
}
