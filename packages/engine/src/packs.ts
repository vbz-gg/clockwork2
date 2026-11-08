/**
 * Data packs: the files a simulation reads.
 *
 * A pack is an asset the manifest declares with `requiredForSim: true`. Its
 * `sha256` and `bytes` are covered by the manifest hash every recording
 * carries, so a recording pins the packs it ran against without a field of
 * its own.
 *
 * The rule everything here follows is that a pack reaches the simulation at a
 * step the simulation chose, never at the moment it arrived. A start pack is
 * readable from `init`. A demand pack is readable in a tick only when the
 * game's `packsNeeded()` named it just before that tick, and the host holds
 * the loop until it has the bytes. Nothing the game can call says whether a
 * pack has arrived, so a slow download, a fast one, a worker and a server
 * replay all run the same steps on the same bytes.
 *
 * This module is simulation code. It decodes UTF-8 itself because
 * `TextDecoder` is a WHATWG API rather than an ECMAScript one, and it hashes
 * with the kernel's own SHA-256 for the same reason.
 */

import type { Effect, PlainValue } from "./contract.js"
import { fail } from "./errors.js"
import { sha256Hex } from "./hash/sha256.js"
import type { AssetDeclaration } from "./manifest/types.js"

/**
 * The effect type a game emits to say it will need a pack soon. Its `data` is
 * a pack path or an array of them. The kernel checks every name, so an
 * undeclared one fails the same tick in every host; the host starts loading
 * and otherwise ignores it. Effects never reach state, so a hint that arrives
 * late or not at all changes nothing but whether the loop has to wait.
 */
export const PREFETCH_EFFECT = "prefetch"

/**
 * The pack paths a prefetch effect names, or null for any other effect. The
 * names are not checked here; the session checks them as the tick ends.
 */
export function prefetchPaths(effect: Effect): readonly unknown[] | null {
  if (effect.type !== PREFETCH_EFFECT) return null
  const data = effect.data
  return Array.isArray(data) ? data : [data]
}

/** Bytes a host hands over. The kernel copies them before it checks them. */
export type PackBytes = ArrayBuffer | Uint8Array

/**
 * The most bytes `json()` will decode: 2^29 - 24, which is V8's longest
 * string. A UTF-8 byte is at least one UTF-16 code unit, so a pack this size
 * or smaller always fits. Larger ones decode on JavaScriptCore and
 * SpiderMonkey and throw on V8, and a pack that worked in one browser and not
 * another is a pack nobody can ship.
 */
export const MAX_JSON_PACK_BYTES = 536_870_888

/**
 * ECMAScript fixes the value of a number with at most 20 significant digits
 * and lets each engine choose between two neighbours above that
 * (RoundMVResult, which `JSON.parse` uses too). So `json()` refuses a longer
 * number rather than let engines read the same pack differently.
 */
export const MAX_JSON_SIGNIFICANT_DIGITS = 20

/** Code units per `String.fromCharCode` call. Argument limits differ by engine. */
const DECODE_CHUNK = 4096

/** What a game reads its packs through. `init` receives it. */
export interface PackReader {
  /**
   * The pack's bytes, as a fresh copy on every call. Writing into it changes
   * nothing anywhere else, so a server that shares one copy of a pack between
   * many replays cannot have one replay corrupt the next.
   */
  open(path: string): Uint8Array
  /**
   * The pack decoded as UTF-8 JSON, parsed afresh on every call. A leading
   * byte order mark is dropped. Invalid UTF-8, invalid JSON, a number with
   * more than 20 significant digits and a pack over `MAX_JSON_PACK_BYTES`
   * are refused with `E_ARG_INVALID`.
   */
  json(path: string): PlainValue
}

/** True for a pack that must arrive before `init`. Absent means start. */
export function isStartPack(asset: AssetDeclaration): boolean {
  return asset.load !== "demand"
}

/** The assets a simulation reads, by path, in declaration order. */
export function logicPacks(
  assets: readonly AssetDeclaration[] | undefined,
): ReadonlyMap<string, AssetDeclaration> {
  const out = new Map<string, AssetDeclaration>()
  for (const asset of assets ?? []) {
    if (asset.requiredForSim) out.set(asset.path, asset)
  }
  return out
}

/**
 * Checks one pack and returns the kernel's own copy of it.
 *
 * The size is checked before anything is hashed, so a pack far larger than
 * declared is refused without reading it twice. The copy is taken before the
 * hash, so the bytes that passed are the bytes kept: a caller that writes into
 * its buffer afterwards, or transfers it to a worker, cannot change what the
 * simulation reads. `new Uint8Array(view)` copies, even from a Node `Buffer`,
 * whose own `slice` does not.
 */
export function verifyPack(
  declared: AssetDeclaration,
  bytes: PackBytes,
): Uint8Array {
  const source = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes)
  if (source.byteLength > declared.bytes) {
    fail("E_PACK_TOO_LARGE", {
      detail: `${declared.path} is ${source.byteLength} bytes or more, the manifest declares ${declared.bytes}`,
    })
  }
  const copy = new Uint8Array(source)
  if (copy.byteLength !== declared.bytes) {
    fail("E_PACK_HASH_MISMATCH", {
      detail: `${declared.path} is ${copy.byteLength} bytes, the manifest declares ${declared.bytes}`,
    })
  }
  const digest = sha256Hex(copy)
  if (digest !== declared.sha256) {
    fail("E_PACK_HASH_MISMATCH", {
      detail: `${declared.path} hashes to ${digest}, the manifest declares ${declared.sha256}`,
    })
  }
  return copy
}

interface Verified {
  readonly declared: ReadonlyMap<string, AssetDeclaration>
  readonly bytes: ReadonlyMap<string, Uint8Array>
}

const VERIFIED = new WeakMap<PackSet, Verified>()

/**
 * Packs the kernel has checked against a manifest, ready to share.
 *
 * Checking a pack means hashing every byte of it: a 32 MiB pack took 234 ms
 * under Bun and 299 ms under node 22 when this was written. A server replaying many runs of one version, or a conformance suite
 * running seventy sessions of one game, checks each pack once here and hands
 * the same set to every session. Each session reads through copies, so
 * sharing is safe. Only `verify` makes one; an object that merely looks like
 * a set is refused.
 */
export class PackSet {
  private constructor() {}

  /**
   * Checks every pack given and keeps the kernel's own copies.
   *
   * @throws E_PACK_UNDECLARED for a path the manifest does not declare as a
   *   pack, E_PACK_TOO_LARGE and E_PACK_HASH_MISMATCH for bytes that are not
   *   the ones declared.
   */
  static verify(
    assets: readonly AssetDeclaration[] | undefined,
    packs: Iterable<readonly [string, PackBytes]>,
  ): PackSet {
    const declared = logicPacks(assets)
    const bytes = new Map<string, Uint8Array>()
    for (const [path, raw] of packs) {
      const declaration = declared.get(path)
      if (declaration === undefined) {
        fail("E_PACK_UNDECLARED", {
          detail: `${path} is not a pack this manifest declares`,
        })
      }
      bytes.set(path, verifyPack(declaration, raw))
    }
    const set = new PackSet()
    VERIFIED.set(set, { declared, bytes })
    return set
  }

  /** The packs in this set, in the order they were given. */
  get paths(): readonly string[] {
    return [...verified(this).bytes.keys()]
  }

  has(path: string): boolean {
    return verified(this).bytes.has(path)
  }
}

/** The kernel's view of a set. Not exported from the package. */
export function verified(set: PackSet): Verified {
  const found = VERIFIED.get(set)
  if (found === undefined) {
    fail("E_ARG_INVALID", {
      detail: "packs must be a PackSet made by PackSet.verify",
    })
  }
  return found
}

/**
 * Strict UTF-8, as the WHATWG decoder does it with `fatal: true`: overlong
 * forms, surrogates, code points past U+10FFFF and truncated sequences are
 * refused rather than replaced, because a replacement character is a silent
 * change to the data. A leading byte order mark is dropped.
 */
export function decodeUtf8(bytes: Uint8Array, path: string): string {
  const parts: string[] = []
  const units: number[] = []
  const length = bytes.length
  let i =
    length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf
      ? 3
      : 0
  const refuse = (at: number): never =>
    fail("E_ARG_INVALID", {
      detail: `${path} is not valid UTF-8 at byte ${at}`,
    })
  const continuation = (at: number, low = 0x80, high = 0xbf): number => {
    if (at >= length) refuse(at)
    const byte = bytes[at] as number
    if (byte < low || byte > high) refuse(at)
    return byte & 0x3f
  }
  while (i < length) {
    const lead = bytes[i] as number
    let point: number
    if (lead < 0x80) {
      point = lead
      i += 1
    } else if (lead >= 0xc2 && lead <= 0xdf) {
      point = ((lead & 0x1f) << 6) | continuation(i + 1)
      i += 2
    } else if (lead >= 0xe0 && lead <= 0xef) {
      const low = lead === 0xe0 ? 0xa0 : 0x80
      const high = lead === 0xed ? 0x9f : 0xbf
      point =
        ((lead & 0x0f) << 12) |
        (continuation(i + 1, low, high) << 6) |
        continuation(i + 2)
      i += 3
    } else if (lead >= 0xf0 && lead <= 0xf4) {
      const low = lead === 0xf0 ? 0x90 : 0x80
      const high = lead === 0xf4 ? 0x8f : 0xbf
      point =
        ((lead & 0x07) << 18) |
        (continuation(i + 1, low, high) << 12) |
        (continuation(i + 2) << 6) |
        continuation(i + 3)
      i += 4
    } else {
      return refuse(i)
    }
    if (point >= 0x10000) {
      const offset = point - 0x10000
      units.push(0xd800 | (offset >>> 10), 0xdc00 | (offset & 0x3ff))
    } else {
      units.push(point)
    }
    if (units.length >= DECODE_CHUNK) {
      parts.push(String.fromCharCode(...units))
      units.length = 0
    }
  }
  if (units.length > 0) parts.push(String.fromCharCode(...units))
  return parts.join("")
}

function isDigit(code: number): boolean {
  return code >= 48 && code <= 57
}

/**
 * Finds a number token with more significant digits than ECMAScript pins.
 *
 * Called on text `JSON.parse` has already accepted, so outside strings a digit
 * or a minus sign can only start a number. Leading and trailing zeros are not
 * significant: `1.000` and `100` each have one significant digit.
 */
function tooPrecise(text: string): number | null {
  let i = 0
  const length = text.length
  while (i < length) {
    const code = text.charCodeAt(i)
    if (code === 34) {
      i++
      while (i < length && text.charCodeAt(i) !== 34) {
        i += text.charCodeAt(i) === 92 ? 2 : 1
      }
      i++
      continue
    }
    if (code !== 45 && !isDigit(code)) {
      i++
      continue
    }
    const start = i
    if (code === 45) i++
    // Digits since the first non-zero one, and that count at the last
    // non-zero one: the significant digits, without building a string.
    let counted = 0
    let significant = 0
    const digit = (): void => {
      const zero = text.charCodeAt(i) === 48
      if (counted > 0 || !zero) counted++
      if (!zero) significant = counted
      i++
    }
    while (i < length && isDigit(text.charCodeAt(i))) digit()
    if (text.charCodeAt(i) === 46) {
      i++
      while (i < length && isDigit(text.charCodeAt(i))) digit()
    }
    const exponent = text.charCodeAt(i)
    if (exponent === 101 || exponent === 69) {
      i++
      const sign = text.charCodeAt(i)
      if (sign === 43 || sign === 45) i++
      while (i < length && isDigit(text.charCodeAt(i))) i++
    }
    if (significant > MAX_JSON_SIGNIFICANT_DIGITS) return start
  }
  return null
}

/** What `PackReader.json` returns for one pack's bytes. */
export function decodeJsonPack(bytes: Uint8Array, path: string): PlainValue {
  if (bytes.byteLength > MAX_JSON_PACK_BYTES) {
    fail("E_ARG_INVALID", {
      detail: `${path} is ${bytes.byteLength} bytes; json() decodes at most ${MAX_JSON_PACK_BYTES}`,
    })
  }
  const text = decodeUtf8(bytes, path)
  let value: PlainValue
  try {
    value = JSON.parse(text) as PlainValue
  } catch (error) {
    return fail("E_ARG_INVALID", {
      detail: `${path} is not valid JSON`,
      cause: error,
    })
  }
  const at = tooPrecise(text)
  if (at !== null) {
    fail("E_ARG_INVALID", {
      detail: `${path} has a number with more than ${MAX_JSON_SIGNIFICANT_DIGITS} significant digits at character ${at}, which engines may read differently`,
    })
  }
  return value
}
