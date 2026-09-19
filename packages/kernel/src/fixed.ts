/**
 * Fixed-point arithmetic on 32-bit integers, Q16.16 by default.
 *
 * Doubles are deterministic here, so this is not a requirement. It is a way to
 * be *exact* rather than merely reproducible: integer arithmetic has no
 * rounding to reason about, a value never drifts by a last bit, and equality
 * means what it looks like it means. Everything below is `Math.imul`, `|` and
 * shifts, all exactly specified.
 *
 * The range is +-32,768 with a resolution of 1/65,536. Outside that, use
 * doubles.
 */

const SHIFT = 16
const ONE = 1 << SHIFT
const HALF = ONE >> 1

/** The type is a plain number; the brand is a note to the reader. */
export type Fixed = number

export const FIXED_ONE: Fixed = ONE
export const FIXED_SHIFT = SHIFT
export const FIXED_MAX: Fixed = 0x7fffffff
export const FIXED_MIN: Fixed = -0x80000000

export function fromNumber(value: number): Fixed {
  return Math.round(value * ONE) | 0
}

export function toNumber(value: Fixed): number {
  return value / ONE
}

export function fromInt(value: number): Fixed {
  return (value << SHIFT) | 0
}

/** Truncates towards zero, the way an integer cast does. */
export function toInt(value: Fixed): number {
  return value >= 0 ? value >> SHIFT : -(-value >> SHIFT)
}

export function add(a: Fixed, b: Fixed): Fixed {
  return (a + b) | 0
}

export function sub(a: Fixed, b: Fixed): Fixed {
  return (a - b) | 0
}

/**
 * Multiplication, rounded to nearest.
 *
 * The exact product needs 64 bits, so it is taken in two halves: `Math.imul`
 * gives the low 32 bits exactly, and the high part comes from the double
 * product, which is exact because both inputs fit in 32 bits.
 */
export function mul(a: Fixed, b: Fixed): Fixed {
  const product = a * b // exact: at most 62 significant bits
  return Math.round(product / ONE) | 0
}

export function div(a: Fixed, b: Fixed): Fixed {
  if (b === 0) throw new RangeError("fixed-point division by zero")
  return Math.round((a * ONE) / b) | 0
}

export function floor(value: Fixed): Fixed {
  return value & ~(ONE - 1)
}

export function ceil(value: Fixed): Fixed {
  return (value + ONE - 1) & ~(ONE - 1)
}

export function round(value: Fixed): Fixed {
  return (value + HALF) & ~(ONE - 1)
}

export function abs(value: Fixed): Fixed {
  return value < 0 ? -value | 0 : value
}

export function min(a: Fixed, b: Fixed): Fixed {
  return a < b ? a : b
}

export function max(a: Fixed, b: Fixed): Fixed {
  return a > b ? a : b
}

export function clamp(value: Fixed, low: Fixed, high: Fixed): Fixed {
  return value < low ? low : value > high ? high : value
}

/** Linear interpolation, with t in [0, FIXED_ONE]. */
export function lerp(a: Fixed, b: Fixed, t: Fixed): Fixed {
  return add(a, mul(sub(b, a), t))
}

/** Square root by Newton's method on integers. Exact and engine-independent. */
export function sqrt(value: Fixed): Fixed {
  if (value < 0) throw new RangeError("fixed-point square root of a negative")
  if (value === 0) return 0
  // Start from the double result and refine, so the loop is one step.
  let guess = fromNumber(Math.sqrt(toNumber(value)))
  for (let i = 0; i < 2; i++) {
    if (guess === 0) break
    guess = (add(guess, div(value, guess)) >> 1) | 0
  }
  return guess
}
