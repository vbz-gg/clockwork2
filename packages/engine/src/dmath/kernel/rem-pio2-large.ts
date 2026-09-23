/**
 * __kernel_rem_pio2, from fdlibm k_rem_pio2.c. See NOTICE.
 *
 * Payne-Hanek argument reduction: x mod pi/2 for an x too large for the
 * Cody-Waite path, computed by multiplying the significand against 2/pi held
 * to 66 words of 24 bits and carrying in integer arithmetic.
 *
 * It is here rather than left as a range error because the alternative is a
 * simulation that works until an angle it has been accumulating for an hour
 * crosses 823,550 radians. Nothing in the routine is approximate: the whole
 * computation is integer multiply-and-carry over an exact table.
 */

import { f64, i32, scalbn } from "../helpers.js"

/** 2/pi, in 24-bit words, most significant first. */
const IPIO2 = new Int32Array([
  0xa2f983, 0x6e4e44, 0x1529fc, 0x2757d1, 0xf534dd, 0xc0db62, 0x95993c,
  0x439041, 0xfe5163, 0xabdebb, 0xc561b7, 0x246e3a, 0x424dd2, 0xe00649,
  0x2eea09, 0xd1921c, 0xfe1deb, 0x1cb129, 0xa73ee8, 0x8235f5, 0x2ebb44,
  0x84e99c, 0x7026b4, 0x5f7e41, 0x3991d6, 0x398353, 0x39f49c, 0x845f8b,
  0xbdf928, 0x3b1ff8, 0x97ffde, 0x05980f, 0xef2f11, 0x8b5a0a, 0x6d1f6d,
  0x367ecf, 0x27cb09, 0xb74f46, 0x3f669e, 0x5fea2d, 0x7527ba, 0xc7ebe5,
  0xf17b3d, 0x0739f7, 0x8a5292, 0xea6bfb, 0x5fb11f, 0x8d5d08, 0x560330,
  0x46fc7b, 0x6babf0, 0xcfbc20, 0x9af436, 0x1da9e3, 0x91615e, 0xe61b08,
  0x659985, 0x5f14a0, 0x68408d, 0xffd880, 0x4d7327, 0x310606, 0x1556ca,
  0x73a8c9, 0x60e27b, 0xc08c6b,
])

/** pi/2 split into 24-bit pieces. */
const PIO2 = new Float64Array([
  1.57079625129699707031, 7.54978941586159635335e-8, 5.39030252995776476554e-15,
  3.28200341580791294123e-22, 1.27065575308067607349e-29,
  1.22933308981111328932e-36, 2.73370053816464559624e-44,
  2.16741683877804819444e-51,
])

const INIT_JK = new Int32Array([2, 3, 4, 6])

const ZERO = 0.0
const ONE = 1.0
const TWO24 = 1.6777216e7
const TWON24 = 5.9604644775390625e-8

export function kernelRemPio2(
  x: Float64Array,
  y: Float64Array,
  e0: number,
  nx: number,
  prec: number,
): number {
  const iq = new Int32Array(20)
  const f = new Float64Array(20)
  const q = new Float64Array(20)
  const fq = new Float64Array(20)

  const jk = i32(INIT_JK, prec)
  const jp = jk

  const jx = nx - 1
  let jv = ((e0 - 3) / 24) | 0
  if (jv < 0) jv = 0
  let q0 = e0 - 24 * (jv + 1)

  // f[0..jx+jk] holds the slice of 2/pi this magnitude needs.
  let j = jv - jx
  const m = jx + jk
  for (let i = 0; i <= m; i++, j++) {
    f[i] = j < 0 ? ZERO : i32(IPIO2, j)
  }

  for (let i = 0; i <= jk; i++) {
    let fw = 0.0
    for (let k = 0; k <= jx; k++) fw += f64(x, k) * f64(f, jx + i - k)
    q[i] = fw
  }

  let jz = jk
  let n = 0
  let ih = 0
  let z = 0.0

  // The loop replaces k_rem_pio2.c's `goto recompute`.
  for (;;) {
    // Distil q[] into 24-bit integer words, most significant last.
    z = f64(q, jz)
    for (let i = 0, jj = jz; jj > 0; i++, jj--) {
      const fw = Math.trunc(TWON24 * z)
      iq[i] = Math.trunc(z - TWO24 * fw)
      z = f64(q, jj - 1) + fw
    }

    z = scalbn(z, q0)
    z -= 8.0 * Math.floor(z * 0.125) // trim off an integer multiple of 8
    n = Math.trunc(z)
    z -= n
    ih = 0
    if (q0 > 0) {
      // The last word decides the integer part.
      const i = i32(iq, jz - 1) >> (24 - q0)
      n += i
      iq[jz - 1] = i32(iq, jz - 1) - (i << (24 - q0))
      ih = i32(iq, jz - 1) >> (23 - q0)
    } else if (q0 === 0) {
      ih = i32(iq, jz - 1) >> 23
    } else if (z >= 0.5) {
      ih = 2
    }

    if (ih > 0) {
      // The fraction is above a half, so take 1 - q and carry the sign out.
      n += 1
      let carry = 0
      for (let i = 0; i < jz; i++) {
        const word = i32(iq, i)
        if (carry === 0) {
          if (word !== 0) {
            carry = 1
            iq[i] = 0x1000000 - word
          }
        } else {
          iq[i] = 0xffffff - word
        }
      }
      if (q0 === 1) iq[jz - 1] = i32(iq, jz - 1) & 0x7fffff
      else if (q0 === 2) iq[jz - 1] = i32(iq, jz - 1) & 0x3fffff
      if (ih === 2) {
        z = ONE - z
        if (carry !== 0) z -= scalbn(ONE, q0)
      }
    }

    if (z !== ZERO) break

    // Everything cancelled, so more words of 2/pi are needed.
    let bits = 0
    for (let i = jz - 1; i >= jk; i--) bits |= i32(iq, i)
    if (bits !== 0) break

    let k = 1
    while (i32(iq, jk - k) === 0) k++
    for (let i = jz + 1; i <= jz + k; i++) {
      f[jx + i] = i32(IPIO2, jv + i)
      let fw = 0.0
      for (let jj = 0; jj <= jx; jj++) fw += f64(x, jj) * f64(f, jx + i - jj)
      q[i] = fw
    }
    jz += k
  }

  // Drop trailing zero words, or split z into another 24-bit word.
  if (z === 0.0) {
    jz -= 1
    q0 -= 24
    while (i32(iq, jz) === 0) {
      jz--
      q0 -= 24
    }
  } else {
    z = scalbn(z, -q0)
    if (z >= TWO24) {
      const fw = Math.trunc(TWON24 * z)
      iq[jz] = Math.trunc(z - TWO24 * fw)
      jz += 1
      q0 += 24
      iq[jz] = Math.trunc(fw)
    } else {
      iq[jz] = Math.trunc(z)
    }
  }

  // Back to floating point.
  let fw = scalbn(ONE, q0)
  for (let i = jz; i >= 0; i--) {
    q[i] = fw * i32(iq, i)
    fw *= TWON24
  }

  // Multiply by pi/2, most significant piece last.
  for (let i = jz; i >= 0; i--) {
    let sum = 0.0
    for (let k = 0; k <= jp && k <= jz - i; k++)
      sum += f64(PIO2, k) * f64(q, i + k)
    fq[jz - i] = sum
  }

  switch (prec) {
    case 0: {
      let sum = 0.0
      for (let i = jz; i >= 0; i--) sum += f64(fq, i)
      y[0] = ih === 0 ? sum : -sum
      break
    }
    case 1:
    case 2: {
      let sum = 0.0
      for (let i = jz; i >= 0; i--) sum += f64(fq, i)
      y[0] = ih === 0 ? sum : -sum
      let tail = f64(fq, 0) - sum
      for (let i = 1; i <= jz; i++) tail += f64(fq, i)
      y[1] = ih === 0 ? tail : -tail
      break
    }
    default: {
      // prec 3: hand the caller three pieces, summed in order.
      for (let i = jz; i > 0; i--) {
        const s = f64(fq, i - 1) + f64(fq, i)
        fq[i] = f64(fq, i) + (f64(fq, i - 1) - s)
        fq[i - 1] = s
      }
      for (let i = jz; i > 1; i--) {
        const s = f64(fq, i - 1) + f64(fq, i)
        fq[i] = f64(fq, i) + (f64(fq, i - 1) - s)
        fq[i - 1] = s
      }
      let sum = 0.0
      for (let i = jz; i >= 2; i--) sum += f64(fq, i)
      if (ih === 0) {
        y[0] = f64(fq, 0)
        y[1] = f64(fq, 1)
        y[2] = sum
      } else {
        y[0] = -f64(fq, 0)
        y[1] = -f64(fq, 1)
        y[2] = -sum
      }
      break
    }
  }
  return n & 7
}
