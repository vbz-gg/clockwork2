/**
 * cbrt, from netlib fdlibm s_cbrt.c (`@(#)s_cbrt.c 1.3 95/01/18`). See NOTICE.
 *
 * ====================================================
 * Copyright (C) 1993 by Sun Microsystems, Inc. All rights reserved.
 *
 * Developed at SunSoft, a Sun Microsystems, Inc. business.
 * Permission to use, copy, modify, and distribute this
 * software is freely granted, provided that this notice
 * is preserved.
 * ====================================================
 *
 * This is the netlib routine, not FreeBSD msun's rewrite of it. msun replaces
 * the rational step with a degree-4 polynomial and rounds the 23-bit estimate
 * through a 64-bit integer add; netlib is the reference every other file in
 * this directory is transcribed from, so cbrt follows it.
 *
 * Three steps, each built from exactly specified operations:
 *
 * 1. A 5-bit estimate made by dividing the high word by three as an integer,
 *    which divides the exponent by three, and adding a bias. A subnormal is
 *    first scaled by 2^54 to make it normal, and B2 takes the 54/3 back out.
 * 2. A rational step to about 23 bits. The C's comment says it "may be
 *    implemented in single precision"; the C computes it in double, and so
 *    does this, so no intermediate is rounded to float32 here.
 * 3. The estimate is chopped to 20 bits and nudged one high-word step up, so
 *    that it is larger than cbrt(x) and `t * t` is exact, then one Newton
 *    step takes it to 53 bits. fdlibm states the error as under 0.667 ulp.
 *
 * The sign is taken off at the start and put back at the end, so
 * `cbrt(-x) === -cbrt(x)` holds bit for bit. Zero of either sign and an
 * infinity are returned as they arrived, and a NaN propagates through
 * `x + x`. The sign bit is read before that check but used only for a finite,
 * non-zero argument, so a NaN's sign never reaches a finite result.
 */

import {
  addToHighWord,
  getHighWord,
  getLowWord,
  setHighWord,
  setLowWord,
} from "../bits.js"

/** B1 = (682-0.03306235651)*2**20 */
const B1 = 715094163
/** B2 = (664-0.03306235651)*2**20 */
const B2 = 696219795

const C = 5.42857142857142815906e-1 // 19/35     = 0x3FE15F15, 0xF15F15F1
const D = -7.0530612244897961105e-1 // -864/1225 = 0xBFE691DE, 0x2532C834
const E = 1.41428571428571436819 // 99/70     = 0x3FF6A0EA, 0x0EA0EA0F
const F = 1.6071428571428572063 // 45/28     = 0x3FF9B6DB, 0x6DB6DB6E
const G = 3.57142857142857150787e-1 // 5/14      = 0x3FD6DB6D, 0xB6DB6DB7

export function cbrt(x: number): number {
  let value = x
  let hx = getHighWord(value) // high word of x
  const sign = hx & 0x80000000 // sign = sign(x)
  hx ^= sign
  if (hx >= 0x7ff00000) return value + value // cbrt(NaN, INF) is itself
  if ((hx | getLowWord(value)) === 0) return value // cbrt(0) is itself

  value = setHighWord(value, hx) // x <- |x|

  // Rough cbrt to 5 bits. C's `hx/3` is integer division of a non-negative
  // int, which Math.trunc of the exact quotient reproduces: below 2^31 the
  // quotient's fractional third is far wider than a double's spacing.
  let t = 0.0
  if (hx < 0x00100000) {
    // subnormal number
    t = setHighWord(t, 0x43500000) // set t = 2**54
    t *= value
    t = setHighWord(t, Math.trunc(getHighWord(t) / 3) + B2)
  } else {
    t = setHighWord(t, Math.trunc(hx / 3) + B1)
  }

  // New cbrt to 23 bits.
  let r = (t * t) / value
  let s = C + r * t
  t *= G + F / (s + E + D / s)

  // Chopped to 20 bits and made larger than cbrt(x).
  t = setLowWord(t, 0)
  t = addToHighWord(t, 0x00000001)

  // One step Newton iteration to 53 bits with error less than 0.667 ulps.
  s = t * t // t*t is exact
  r = value / s
  const w = t + t
  r = (r - t) / (w + r) // r-s is exact
  t = t + t * r

  // Restore the sign bit.
  return setHighWord(t, getHighWord(t) | sign)
}
