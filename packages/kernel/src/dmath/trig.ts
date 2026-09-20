/**
 * sin, cos and tan, from fdlibm s_sin.c, s_cos.c and s_tan.c. See NOTICE.
 *
 * They share one scratch pair for the reduced argument, which is what makes
 * them allocation-free in the hot loop and non-reentrant. Single-threaded per
 * realm, and each worker holds its own module instance, so that is safe.
 */

import { getHighWord } from "../bits"
import { HW_PI_4 } from "./constants"
import { kernelCos } from "./kernel/cos"
import { remPio2 } from "./kernel/rem-pio2"
import { kernelSin } from "./kernel/sin"
import { kernelTan } from "./kernel/tan"

const reduced = new Float64Array(2)

export function sin(x: number): number {
  const ix = getHighWord(x) & 0x7fffffff
  if (ix <= HW_PI_4) return kernelSin(x, 0.0, 0)
  if (ix >= 0x7ff00000) return x - x // NaN for Infinity, NaN for NaN
  const n = remPio2(x, reduced)
  const y0 = reduced[0] as number
  const y1 = reduced[1] as number
  switch (n & 3) {
    case 0:
      return kernelSin(y0, y1, 1)
    case 1:
      return kernelCos(y0, y1)
    case 2:
      return -kernelSin(y0, y1, 1)
    default:
      return -kernelCos(y0, y1)
  }
}

export function cos(x: number): number {
  const ix = getHighWord(x) & 0x7fffffff
  if (ix <= HW_PI_4) return kernelCos(x, 0.0)
  if (ix >= 0x7ff00000) return x - x
  const n = remPio2(x, reduced)
  const y0 = reduced[0] as number
  const y1 = reduced[1] as number
  switch (n & 3) {
    case 0:
      return kernelCos(y0, y1)
    case 1:
      return -kernelSin(y0, y1, 1)
    case 2:
      return -kernelCos(y0, y1)
    default:
      return kernelSin(y0, y1, 1)
  }
}

export function tan(x: number): number {
  const ix = getHighWord(x) & 0x7fffffff
  if (ix <= HW_PI_4) return kernelTan(x, 0.0, 1)
  if (ix >= 0x7ff00000) return x - x
  const n = remPio2(x, reduced)
  // 1 when n is even, -1 when odd: tan and cot swap every quarter turn.
  return kernelTan(
    reduced[0] as number,
    reduced[1] as number,
    1 - ((n & 1) << 1),
  )
}
