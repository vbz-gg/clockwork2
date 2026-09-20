/**
 * Reading and writing the two 32-bit halves of a double.
 *
 * Every routine here uses one module-level scratch buffer, which is what makes
 * it fast and what makes it non-reentrant. That is fine in a single-threaded
 * realm, and each worker gets its own copy of the module.
 *
 * Typed-array views follow the platform's byte order. In practice every engine
 * that matters runs little-endian, but Node ships an s390x build, so the layout
 * is probed once here rather than assumed. Two lines, one branch at load.
 */

const SCRATCH = new Float64Array(1)
const WORDS = new Uint32Array(SCRATCH.buffer)
const BYTES = new BigUint64Array(SCRATCH.buffer)

SCRATCH[0] = 1.0

/** Index of the high word (sign, exponent, top 20 bits of the significand). */
export const HI: 0 | 1 = WORDS[1] === 0x3ff00000 ? 1 : 0
/** Index of the low word (bottom 32 bits of the significand). */
export const LO: 0 | 1 = HI === 1 ? 0 : 1

if (WORDS[HI] !== 0x3ff00000 || WORDS[LO] !== 0) {
  throw new Error(
    "clockwork2: unexpected IEEE 754 double layout; this build cannot be trusted to be deterministic",
  )
}

/**
 * The high word, as a *signed* int32, so that `hx < 0` reads the sign bit the
 * way the C it was transcribed from does.
 */
export function getHighWord(x: number): number {
  SCRATCH[0] = x
  // The parentheses matter: `WORDS[HI] as number | 0` is a type assertion to
  // `number | 0`, not a bitwise or, so the word would stay unsigned and every
  // `hx < 0` sign test downstream would silently read false.
  return (WORDS[HI] as number) | 0
}

export function getLowWord(x: number): number {
  SCRATCH[0] = x
  return (WORDS[LO] as number) | 0
}

export function setHighWord(x: number, hi: number): number {
  SCRATCH[0] = x
  WORDS[HI] = hi >>> 0
  return SCRATCH[0] as number
}

export function setLowWord(x: number, lo: number): number {
  SCRATCH[0] = x
  WORDS[LO] = lo >>> 0
  return SCRATCH[0] as number
}

export function fromWords(hi: number, lo: number): number {
  WORDS[HI] = hi >>> 0
  WORDS[LO] = lo >>> 0
  return SCRATCH[0] as number
}

/** Adds to the high word without touching the low one. */
export function addToHighWord(x: number, delta: number): number {
  SCRATCH[0] = x
  WORDS[HI] = ((WORDS[HI] as number) + delta) >>> 0
  return SCRATCH[0] as number
}

/** The whole 64-bit pattern, for hashing, golden vectors and equality. */
export function toBits(x: number): bigint {
  SCRATCH[0] = x
  return BYTES[0] as bigint
}

export function fromBits(bits: bigint): number {
  BYTES[0] = bits
  return SCRATCH[0] as number
}

/** The 16-hex-digit form used in vectors and in every divergence report. */
export function toBitsHex(x: number): string {
  return toBits(x).toString(16).padStart(16, "0").toUpperCase()
}

export function fromBitsHex(hex: string): number {
  return fromBits(BigInt(`0x${hex}`))
}

/** The next representable double towards +Infinity. Used by tests. */
export function nextUp(x: number): number {
  if (Number.isNaN(x)) return x
  if (x === Number.POSITIVE_INFINITY) return x
  if (x === 0) return fromBits(1n)
  const bits = toBits(x)
  // The sign bit makes the pattern descend for negatives, so step the other way.
  return fromBits(bits >= 0x8000000000000000n ? bits - 1n : bits + 1n)
}

export function nextDown(x: number): number {
  if (Number.isNaN(x)) return x
  if (x === Number.NEGATIVE_INFINITY) return x
  if (x === 0) return fromBits(0x8000000000000001n)
  const bits = toBits(x)
  return fromBits(bits >= 0x8000000000000000n ? bits + 1n : bits - 1n)
}

/**
 * Distance in representable doubles. Returns -1n when only one side is NaN,
 * so a caller can tell "both NaN" from "one NaN".
 */
export function ulpDistance(a: number, b: number): bigint {
  const aNaN = Number.isNaN(a)
  const bNaN = Number.isNaN(b)
  if (aNaN || bNaN) return aNaN && bNaN ? 0n : -1n
  const order = (x: number): bigint => {
    const raw = toBits(x)
    // Map the sign-magnitude pattern onto a monotone integer line.
    return raw >= 0x8000000000000000n ? -(raw - 0x8000000000000000n) : raw
  }
  const x = order(a)
  const y = order(b)
  return x > y ? x - y : y - x
}
