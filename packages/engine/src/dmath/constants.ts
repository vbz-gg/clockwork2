/**
 * Named thresholds, so a branch in a transcribed routine can be read against
 * the C it came from without decoding a bare hex literal.
 *
 * Every `HW_` value is a high word: the top 32 bits of a double, which is what
 * fdlibm branches on.
 */

/** pi/4. Below this, sin and cos need no argument reduction. */
export const HW_PI_4 = 0x3fe921fb
/** 3pi/4. Below this, one subtraction of a split pi/2 is enough. */
export const HW_3PI_4 = 0x4002d97c
/** pi/2 exactly, the case the 33+53 bit split is not accurate enough for. */
export const HW_PI_2 = 0x3ff921fb
/** 2^19 * (pi/2). Above this, reduction needs the Payne-Hanek path. */
export const HW_REM_PIO2_MEDIUM_MAX = 0x413921fb

/** The largest argument sin, cos and tan reduce through the medium path. */
export const REM_PIO2_MEDIUM_MAX = 8.235496655462106e5 // 2^19 * (pi/2)

export const PI = 3.141592653589793
export const PI_2 = 1.5707963267948966
export const PI_4 = 0.7853981633974483
export const TWO_PI = 6.283185307179586

/** Splits of pi/2 at 33, 33+33, 33+33+33 and 53 bits, from e_rem_pio2.c. */
export const INVPIO2 = 6.36619772367581382433e-1
export const PIO2_1 = 1.57079632673412561417
export const PIO2_1T = 6.07710050650619224932e-11
export const PIO2_2 = 6.0771005063039659766e-11
export const PIO2_2T = 2.02226624879595063154e-21
export const PIO2_3 = 2.0222662487111664558e-21
export const PIO2_3T = 8.47842766036889956997e-32

export const TWO24 = 1.6777216e7
export const TWON24 = 5.9604644775390625e-8
export const TWO53 = 9007199254740992
export const HUGE = 1e300
export const TINY = 1e-300

/*
 * A note on how the constants above are written.
 *
 * They carry more digits than a double holds, because they are copied from
 * netlib fdlibm character for character. Keeping the reference's own form is
 * what makes a transcription reviewable against the C, and the extra digits
 * round away to exactly the same double. Biome's noPrecisionLoss and
 * noApproximativeNumericConstant rules are turned off for this directory in
 * biome.json for that reason, and for that reason only.
 */
