/**
 * A 64-bit hash held in two 32-bit lanes.
 *
 * Two lanes rather than a BigInt because `Math.imul`, `^`, `<<` and `>>>` are
 * exactly specified and fast, so the same bytes give the same digest on every
 * engine, and the cost is low enough to run inside `tick` once a second.
 *
 * This is a checksum for spotting divergence, not a security primitive. What
 * stops a player claiming a score is the server replaying the input log, not
 * the width of this hash.
 */

import { toBits } from "../bits"

const C1 = 0xcc9e2d51
const C2 = 0x1b873593
const C3 = 0x2545f491
const SEED_1 = 0x9e3779b1 | 0
const SEED_2 = 0x85ebca6b | 0

/** MurmurHash3's 32-bit finaliser. */
function fmix32(h: number): number {
  let x = h | 0
  x ^= x >>> 16
  x = Math.imul(x, 0x85ebca6b)
  x ^= x >>> 13
  x = Math.imul(x, 0xc2b2ae35)
  x ^= x >>> 16
  return x | 0
}

function hex8(value: number): string {
  return (value >>> 0).toString(16).padStart(8, "0")
}

/**
 * Incremental so that a large snapshot can be hashed without first building a
 * large string.
 *
 * Input is consumed as UTF-16 code units. That is exactly specified, keeps
 * lone surrogates distinguishable, and avoids a UTF-8 conversion in the hot
 * path.
 */
export class Hash64 {
  private h1 = SEED_1
  private h2 = SEED_2
  private length = 0

  update(text: string): this {
    let h1 = this.h1
    let h2 = this.h2
    for (let i = 0; i < text.length; i++) {
      let k = text.charCodeAt(i)
      k = Math.imul(k, C1)
      k = (k << 15) | (k >>> 17)
      k = Math.imul(k, C2)

      h1 ^= k
      h1 = (h1 << 13) | (h1 >>> 19)
      h1 = (Math.imul(h1, 5) + 0xe6546b64) | 0

      h2 ^= Math.imul(k, C3)
      h2 = (h2 << 17) | (h2 >>> 15)
      h2 = (Math.imul(h2, 3) + 0x9e3779b9) | 0
    }
    this.h1 = h1
    this.h2 = h2
    this.length += text.length
    return this
  }

  /** Feeds a double by its bit pattern, so -0 and 0 stay different. */
  updateNumber(value: number): this {
    const bits = toBits(value)
    return this.update(bits.toString(16).padStart(16, "0"))
  }

  /** 16 lowercase hex digits. Calling it does not end the hasher. */
  digest(): string {
    let h1 = this.h1 ^ this.length
    let h2 = this.h2 ^ this.length
    h1 = (h1 + h2) | 0
    h2 = (h2 + h1) | 0
    h1 = fmix32(h1)
    h2 = fmix32(h2)
    h1 = (h1 + h2) | 0
    h2 = (h2 + h1) | 0
    return hex8(h1) + hex8(h2)
  }

  reset(): this {
    this.h1 = SEED_1
    this.h2 = SEED_2
    this.length = 0
    return this
  }
}

/** One-shot form. */
export function hash64(text: string): string {
  return new Hash64().update(text).digest()
}
