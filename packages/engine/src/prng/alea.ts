/**
 * alea, transcribed from alea 1.0.1 by Johannes Baagoe. See NOTICE.
 *
 * Vendored rather than depended upon so the kernel has no runtime
 * dependencies. `tests/prng/alea-parity.test.ts` proves this copy produces the
 * same bits as the published package, and holds a hash of the upstream file so
 * that a change under a pinned version is reported rather than discovered.
 *
 * It is worth saying why alea is safe to rely on here. Its step is
 * `t = 2091639 * s0 + c * 2.3283064365386963e-10; c = t | 0; s2 = t - c`, and
 * Mash uses only `charCodeAt`, `+`, `-`, `*` and `>>>`. Every one of those is
 * exactly specified by ECMAScript, so the stream is bit-identical on V8,
 * JavaScriptCore and SpiderMonkey. Nothing here calls a transcendental.
 *
 * One deliberate difference from upstream: calling this with no seed throws.
 * Upstream falls back to `+new Date`, which is a non-deterministic default in
 * a library whose entire purpose is determinism. Clockwork 1 inherited that
 * default and constructed its PRNG unseeded.
 */

import { fail } from "../errors.js"

/** `[s0, s1, s2, c]`, the same shape upstream's `exportState` returns. */
export type AleaState = readonly [number, number, number, number]

export interface Alea {
  (): number
  /** Same as calling it. Kept for readability at the call site. */
  next(): number
  /** A uniform 32-bit unsigned integer, as a double. */
  uint32(): number
  /** 53 bits of randomness, at the cost of two draws. */
  fract53(): number
  exportState(): AleaState
  importState(state: AleaState): void
}

type MashInput = string | number

function createMash(): (data: MashInput) => number {
  let n = 0xefc8249d

  return (input: MashInput): number => {
    const data = String(input)
    for (let i = 0; i < data.length; i++) {
      n += data.charCodeAt(i)
      let h = 0.02519603282416938 * n
      n = h >>> 0
      h -= n
      h *= n
      n = h >>> 0
      h -= n
      n += h * 0x100000000 // 2^32
    }
    return (n >>> 0) * 2.3283064365386963e-10 // 2^-32
  }
}

export function createAlea(...args: ReadonlyArray<MashInput>): Alea {
  if (args.length === 0) {
    fail("E_SEED_REQUIRED", { detail: "createAlea() needs at least one seed" })
  }

  let s0 = 0
  let s1 = 0
  let s2 = 0
  let c = 1

  const mash = createMash()
  s0 = mash(" ")
  s1 = mash(" ")
  s2 = mash(" ")

  for (let i = 0; i < args.length; i++) {
    const arg = args[i] as MashInput
    s0 -= mash(arg)
    if (s0 < 0) s0 += 1
    s1 -= mash(arg)
    if (s1 < 0) s1 += 1
    s2 -= mash(arg)
    if (s2 < 0) s2 += 1
  }

  const random = (): number => {
    const t = 2091639 * s0 + c * 2.3283064365386963e-10 // 2^-32
    s0 = s1
    s1 = s2
    c = t | 0
    s2 = t - c
    return s2
  }

  const alea = random as unknown as Alea
  alea.next = random
  alea.uint32 = (): number => random() * 0x100000000 // 2^32
  alea.fract53 = (): number =>
    random() + ((random() * 0x200000) | 0) * 1.1102230246251565e-16 // 2^-53
  alea.exportState = (): AleaState => [s0, s1, s2, c]
  alea.importState = (state: AleaState): void => {
    s0 = +state[0] || 0
    s1 = +state[1] || 0
    s2 = +state[2] || 0
    c = +state[3] || 0
  }

  return alea
}
