/**
 * Deterministic replacements for the parts of `Math` that ECMAScript leaves
 * implementation-defined.
 *
 * The specification says outright that the behaviour of "acos, acosh, asin,
 * asinh, atan, atanh, atan2, cbrt, cos, cosh, exp, expm1, hypot, log, log1p,
 * log2, log10, pow, random, sin, sinh, tan, and tanh is not precisely
 * specified", and engines take it up on that. Measured here on 20,000 seeded
 * inputs per function between JavaScriptCore and V8: `Math.hypot` disagreed on
 * 32.6% of them, `Math.exp` on 10.3%, `Math.pow` on 9.0%, `Math.cos` on 3.2%.
 * `Math.sqrt`, which *is* exactly specified, disagreed on none.
 *
 * Everything here is built from operations the standard pins down: `+ - * / %`,
 * comparisons, `Math.sqrt`, the rounding family, `Math.fround`, `Math.imul`,
 * `Math.clz32`, and typed-array bit manipulation. The names match `Math` so
 * that reaching for the right thing takes no thought:
 *
 * ```ts
 * import * as dmath from "@clockwork2/kernel/dmath"
 * const x = dmath.cos(angle) * radius
 * ```
 */

export { acos, asin, atan, atan2 } from "./atan"
export { PI, PI_2, PI_4, TWO_PI } from "./constants"
export { exp } from "./exp"
export { copysign, scalbn } from "./helpers"
export { log, log2, log10 } from "./log"
export {
  exp2i,
  f32,
  f32add,
  f32div,
  f32FromBits,
  f32mul,
  f32sub,
  f32ToBits,
  hypot,
  isNegative,
  sign,
  wrapAngle,
} from "./misc"
export { ipow, pow } from "./pow"
export { cos, sin, tan } from "./trig"

/**
 * Re-exported so that a simulation can import every number it needs from one
 * place. `Math.sqrt` has been exactly specified since August 2024 and is safe
 * to call directly; this is here for uniformity at the call site, not because
 * the built-in is a problem.
 */
export const sqrt = Math.sqrt
export const abs = Math.abs
export const floor = Math.floor
export const ceil = Math.ceil
export const round = Math.round
export const trunc = Math.trunc
export const min = Math.min
export const max = Math.max
export const fround = Math.fround
export const imul = Math.imul
export const clz32 = Math.clz32
