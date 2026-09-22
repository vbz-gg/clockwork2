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
 * import * as dmath from "."
 * const x = dmath.cos(angle) * radius
 * ```
 *
 * ## The one thing not bit-identical across machines: a NaN's sign
 *
 * Every finite result here is the same bits on every engine and every
 * architecture. A NaN is not, and cannot be. ECMAScript leaves a NaN's sign
 * and payload to the implementation, and the hardware differs: an invalid
 * operation produces the negative quiet NaN `0xFFF8000000000000` on x86 and
 * the positive `0x7FF8000000000000` on arm64. So `dmath.log(-1)` returns a NaN
 * with a different sign bit on an Apple Silicon Mac than on an x86 Linux
 * server, and no amount of care here can change that - the bits never pass
 * through JavaScript arithmetic, they come straight from the FPU.
 *
 * A NaN that *arrives* as an argument is propagated with its sign intact, so
 * only a freshly generated one differs. Measured across the golden vectors:
 * 1074 of 1212 NaN results.
 *
 * This is safe, because a NaN cannot reach anything that decides a score.
 * `hashCanonical` refuses one rather than encoding it, counters must be whole
 * numbers, and a recording is JSON, where `JSON.stringify(NaN)` is `null` and
 * the decoder rejects it. A simulation that produces a NaN has a bug, and the
 * kernel makes that bug loud instead of letting it settle into a hash.
 *
 * The consequence for tests: a golden vector whose result is a NaN asserts
 * that the result *is* a NaN, never which one. Pinning the sign would pin the
 * architecture, and the suite would fail on every arm64 machine.
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
