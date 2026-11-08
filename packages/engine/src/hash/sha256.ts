/**
 * SHA-256, as FIPS 180-4 defines it.
 *
 * A pack is named by the SHA-256 of its bytes, and the kernel checks that name
 * before a simulation may read the pack. The check has to give the same
 * answer in a browser, in a worker and on a server, and it runs where neither
 * `node:crypto` nor Web Crypto is available: Web Crypto is trapped inside the
 * simulation and is asynchronous anyway. So it is written here, from the
 * standard, out of operations ECMAScript specifies exactly: `|`, `^`, `&`,
 * `~`, `>>>`, `<<` and addition folded back to 32 bits.
 *
 * The message length is written as two 32-bit words found by division rather
 * than by shifting. `bytes << 3` reaches the sign bit at 256 MiB and gives a
 * wrong digest for every pack past that size with no error at all.
 */

const K = new Int32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1,
  0x923f82a4, 0xab1c5ed5, 0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3,
  0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174, 0xe49b69c1, 0xefbe4786,
  0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147,
  0x06ca6351, 0x14292967, 0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13,
  0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85, 0xa2bfe8a1, 0xa81a664b,
  0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a,
  0x5b9cca4f, 0x682e6ff3, 0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208,
  0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
])

const INITIAL = [
  0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c,
  0x1f83d9ab, 0x5be0cd19,
]

const HEX = "0123456789abcdef"

/** 2^29: a byte count divided by this is the high word of its bit count. */
const BYTES_PER_HIGH_WORD = 0x20000000

/**
 * Hex by table rather than `toString(16)`. ECMAScript defines
 * `Number.prototype.toString` exactly only for radix 10.
 */
function hex32(value: number): string {
  let out = ""
  for (let shift = 28; shift >= 0; shift -= 4) {
    out += HEX[(value >>> shift) & 15]
  }
  return out
}

function compress(
  state: Int32Array,
  w: Int32Array,
  block: Uint8Array,
  at: number,
): void {
  for (let i = 0; i < 16; i++) {
    const j = at + i * 4
    w[i] =
      ((block[j] as number) << 24) |
      ((block[j + 1] as number) << 16) |
      ((block[j + 2] as number) << 8) |
      (block[j + 3] as number)
  }
  for (let i = 16; i < 64; i++) {
    const x = w[i - 15] as number
    const y = w[i - 2] as number
    const s0 = ((x >>> 7) | (x << 25)) ^ ((x >>> 18) | (x << 14)) ^ (x >>> 3)
    const s1 = ((y >>> 17) | (y << 15)) ^ ((y >>> 19) | (y << 13)) ^ (y >>> 10)
    w[i] = ((w[i - 16] as number) + s0 + (w[i - 7] as number) + s1) | 0
  }

  let a = state[0] as number
  let b = state[1] as number
  let c = state[2] as number
  let d = state[3] as number
  let e = state[4] as number
  let f = state[5] as number
  let g = state[6] as number
  let h = state[7] as number

  for (let i = 0; i < 64; i++) {
    const S1 =
      ((e >>> 6) | (e << 26)) ^
      ((e >>> 11) | (e << 21)) ^
      ((e >>> 25) | (e << 7))
    const ch = (e & f) ^ (~e & g)
    const t1 = (h + S1 + ch + (K[i] as number) + (w[i] as number)) | 0
    const S0 =
      ((a >>> 2) | (a << 30)) ^
      ((a >>> 13) | (a << 19)) ^
      ((a >>> 22) | (a << 10))
    const maj = (a & b) ^ (a & c) ^ (b & c)
    const t2 = (S0 + maj) | 0
    h = g
    g = f
    f = e
    e = (d + t1) | 0
    d = c
    c = b
    b = a
    a = (t1 + t2) | 0
  }

  state[0] = ((state[0] as number) + a) | 0
  state[1] = ((state[1] as number) + b) | 0
  state[2] = ((state[2] as number) + c) | 0
  state[3] = ((state[3] as number) + d) | 0
  state[4] = ((state[4] as number) + e) | 0
  state[5] = ((state[5] as number) + f) | 0
  state[6] = ((state[6] as number) + g) | 0
  state[7] = ((state[7] as number) + h) | 0
}

/**
 * The digest of `bytes`, as 64 lowercase hex digits.
 *
 * @param lengthOverride the byte count to write into the padding instead of
 *   `bytes.length`. Only the probe uses it, to pin the padding of a message
 *   longer than any engine can allocate; a digest computed with it is not the
 *   digest of `bytes`.
 */
export function sha256Hex(bytes: Uint8Array, lengthOverride?: number): string {
  const state = new Int32Array(INITIAL)
  const w = new Int32Array(64)
  const length = bytes.length
  const whole = length - (length % 64)
  for (let at = 0; at < whole; at += 64) compress(state, w, bytes, at)

  // The tail, a 1 bit, zeros, and the length in bits as a 64-bit big-endian
  // number. One block when the tail leaves room for the length, two when not.
  const tail = new Uint8Array(length - whole < 56 ? 64 : 128)
  tail.set(bytes.subarray(whole))
  tail[length - whole] = 0x80
  const counted = lengthOverride ?? length
  const high = Math.floor(counted / BYTES_PER_HIGH_WORD)
  const low = (counted % BYTES_PER_HIGH_WORD) * 8
  const end = tail.length
  tail[end - 8] = (high >>> 24) & 0xff
  tail[end - 7] = (high >>> 16) & 0xff
  tail[end - 6] = (high >>> 8) & 0xff
  tail[end - 5] = high & 0xff
  tail[end - 4] = (low >>> 24) & 0xff
  tail[end - 3] = (low >>> 16) & 0xff
  tail[end - 2] = (low >>> 8) & 0xff
  tail[end - 1] = low & 0xff
  for (let at = 0; at < end; at += 64) compress(state, w, tail, at)

  let out = ""
  for (let i = 0; i < 8; i++) out += hex32(state[i] as number)
  return out
}
