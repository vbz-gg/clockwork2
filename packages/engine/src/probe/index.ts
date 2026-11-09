/**
 * The cross-engine probe.
 *
 * One function, exported from the kernel, that every JavaScript engine runs to
 * produce the same bytes. `scripts/engines.ts` bundles this once and runs the
 * identical bundle under Bun, Node and each installed browser, so a difference
 * in the output is a difference in the engine rather than in a transpiler.
 *
 * Nothing here reads a clock. A probe that timed itself would be the one piece
 * of the kernel that could not pass the kernel's own purity scan.
 */

import { toBitsHex } from "../bits.js"
import * as dmath from "../dmath/index.js"
import { fail, isClockworkError } from "../errors.js"
import { encodeCanonical } from "../hash/canonical.js"
import { Hash64, hash64 } from "../hash/hash64.js"
import { sha256Hex } from "../hash/sha256.js"
import { RecordedInputSource } from "../inputs.js"
import { runSession } from "../loop.js"
import { decodeJsonPack, decodeUtf8 } from "../packs.js"
import { Prng } from "../prng/index.js"
import { botLog } from "../testing/input-logs.js"
import {
  createReferenceGame,
  REFERENCE_CONFIG,
  REFERENCE_COUNTERS,
} from "../testing/reference-game.js"

/** 2 added the data pack vectors: SHA-256, UTF-8 decoding and pack JSON. */
export const PROBE_VERSION = 2

export type ProbeItem = {
  /** The input, in a form a person can read in a divergence report. */
  readonly in: string
  /** The result, as bits. */
  readonly out: string
}

type VectorDefinition = {
  readonly id: string
  readonly count: number
  readonly heavy?: boolean
  readonly produce: () => Generator<ProbeItem>
}

const SEED = "clockwork2-probe"

function* dmathVector(
  name: string,
  fn: (x: number) => number,
  lo: number,
  hi: number,
  count: number,
): Generator<ProbeItem> {
  const rng = new Prng(`${SEED}:${name}`)
  for (let i = 0; i < count; i++) {
    const x = rng.randomFloat(lo, hi)
    yield { in: toBitsHex(x), out: toBitsHex(fn(x)) }
  }
}

function* binaryVector(
  name: string,
  fn: (a: number, b: number) => number,
  lo: number,
  hi: number,
  count: number,
): Generator<ProbeItem> {
  const rng = new Prng(`${SEED}:${name}`)
  for (let i = 0; i < count; i++) {
    const a = rng.randomFloat(lo, hi)
    const b = rng.randomFloat(lo, hi)
    yield { in: `${toBitsHex(a)},${toBitsHex(b)}`, out: toBitsHex(fn(a, b)) }
  }
}

const N = 100_000
const M = 20_000

/** UTF-8 for code points the probe draws, none of them surrogates. */
function encodeUtf8(points: readonly number[]): Uint8Array {
  const out: number[] = []
  for (const point of points) {
    if (point < 0x80) out.push(point)
    else if (point < 0x800) out.push(0xc0 | (point >> 6), 0x80 | (point & 63))
    else if (point < 0x10000) {
      out.push(
        0xe0 | (point >> 12),
        0x80 | ((point >> 6) & 63),
        0x80 | (point & 63),
      )
    } else {
      out.push(
        0xf0 | (point >> 18),
        0x80 | ((point >> 12) & 63),
        0x80 | ((point >> 6) & 63),
        0x80 | (point & 63),
      )
    }
  }
  return new Uint8Array(out)
}

/** A code point from one of the four UTF-8 lengths, never a surrogate. */
function drawPoint(rng: Prng): number {
  switch (rng.randomInt(0, 3)) {
    case 0:
      return rng.randomInt(0, 0x7f)
    case 1:
      return rng.randomInt(0x80, 0x7ff)
    case 2: {
      const point = rng.randomInt(0x800, 0xffff - 0x800)
      return point >= 0xd800 ? point + 0x800 : point
    }
    default:
      return rng.randomInt(0x10000, 0x10ffff)
  }
}

/** A JSON number with `digits` significant digits and a modest exponent. */
function drawNumber(rng: Prng, digits: number): string {
  let mantissa = String(rng.randomInt(1, 9))
  for (let i = 1; i < digits; i++) mantissa += String(rng.randomInt(0, 9))
  const sign = rng.randomBoolean() ? "-" : ""
  const point = rng.randomInt(1, mantissa.length)
  const body =
    point === mantissa.length
      ? mantissa
      : `${mantissa.slice(0, point)}.${mantissa.slice(point)}`
  const exponent = rng.randomBoolean(0.6) ? `e${rng.randomInt(-300, 280)}` : ""
  return `${sign}${body}${exponent}`
}

/** The result of reading, or the code of the refusal: both must agree. */
function attempt(read: () => string): string {
  try {
    return read()
  } catch (error) {
    if (isClockworkError(error)) return error.code
    throw error
  }
}

function buildDefinitions(): readonly VectorDefinition[] {
  const definitions: VectorDefinition[] = [
    {
      id: "prng/alea-next",
      count: N,
      *produce() {
        const rng = new Prng(SEED)
        for (let i = 0; i < N; i++)
          yield { in: String(i), out: toBitsHex(rng.random()) }
      },
    },
    {
      id: "prng/alea-uint32",
      count: 50_000,
      *produce() {
        const rng = new Prng(SEED)
        for (let i = 0; i < 50_000; i++) {
          yield { in: String(i), out: toBitsHex(rng.randomUint32()) }
        }
      },
    },
    {
      id: "prng/alea-state",
      count: 1_000,
      *produce() {
        const rng = new Prng(SEED)
        for (let i = 0; i < 1_000; i++) {
          for (let j = 0; j < 997; j++) rng.random()
          const exported = rng.exportState()
          const resumed = new Prng(SEED)
          resumed.importState(exported)
          yield { in: String(i), out: toBitsHex(resumed.random()) }
        }
      },
    },
    {
      id: "prng/substreams",
      count: 20_000,
      *produce() {
        const rng = new Prng(SEED)
        const labels = ["fx", "spawn", "ai", "loot"]
        for (let i = 0; i < 20_000; i++) {
          const label = labels[i % labels.length] as string
          yield { in: label, out: toBitsHex(rng.stream(label).random()) }
        }
      },
    },
  ]

  const unary: Array<[string, (x: number) => number, number, number]> = [
    ["sin", dmath.sin, -1e9, 1e9],
    ["cos", dmath.cos, -1e9, 1e9],
    ["tan", dmath.tan, -1e9, 1e9],
    ["asin", dmath.asin, -1, 1],
    ["acos", dmath.acos, -1, 1],
    ["atan", dmath.atan, -1e6, 1e6],
    ["exp", dmath.exp, -700, 700],
    ["log", dmath.log, 1e-300, 1e300],
    ["log2", dmath.log2, 1e-300, 1e300],
    ["log10", dmath.log10, 1e-300, 1e300],
    ["wrapAngle", dmath.wrapAngle, -1e9, 1e9],
  ]
  for (const [name, fn, lo, hi] of unary) {
    definitions.push({
      id: `dmath/${name}`,
      count: M,
      produce: () => dmathVector(name, fn, lo, hi, M),
    })
  }
  definitions.push({
    id: "dmath/atan2",
    count: M,
    produce: () => binaryVector("atan2", dmath.atan2, -2000, 2000, M),
  })
  definitions.push({
    id: "dmath/hypot",
    count: M,
    produce: () => binaryVector("hypot", dmath.hypot, -1e6, 1e6, M),
  })
  definitions.push({
    id: "dmath/pow",
    count: M,
    *produce() {
      const rng = new Prng(`${SEED}:pow`)
      for (let i = 0; i < M; i++) {
        const base = rng.randomFloat(0, 200)
        const exponent = rng.randomFloat(-30, 30)
        yield {
          in: `${toBitsHex(base)},${toBitsHex(exponent)}`,
          out: toBitsHex(dmath.pow(base, exponent)),
        }
      }
    },
  })
  definitions.push({
    id: "dmath/ipow",
    count: M,
    *produce() {
      const rng = new Prng(`${SEED}:ipow`)
      for (let i = 0; i < M; i++) {
        const base = rng.randomFloat(-10, 10)
        const exponent = rng.randomInt(-20, 20)
        yield {
          in: `${toBitsHex(base)},${exponent}`,
          out: toBitsHex(dmath.ipow(base, exponent)),
        }
      }
    },
  })

  definitions.push({
    id: "hash/canonical",
    count: 10_000,
    *produce() {
      const rng = new Prng(`${SEED}:hash`)
      for (let i = 0; i < 10_000; i++) {
        const value = {
          i,
          f: rng.randomFloat(-1e9, 1e9),
          neg: i % 7 === 0 ? -0 : 0,
          sub: rng.randomFloat(0, 1e-300),
          text: `\u{1F3B2}${String.fromCharCode(0xd800 + (i % 1024))}${i}`,
          list: [rng.randomInt(-1e9, 1e9), rng.randomBoolean(), null],
        }
        yield { in: String(i), out: hash64(encodeCanonical(value)) }
      }
    },
  })

  definitions.push({
    id: "encoding/number-roundtrip",
    count: 50_000,
    *produce() {
      // Number::toString is exactly specified, but a recording travels through
      // JSON, so a difference here would break replay exactly as thoroughly as
      // a difference in dmath and would otherwise never be tested.
      const rng = new Prng(`${SEED}:encoding`)
      for (let i = 0; i < 50_000; i++) {
        const value =
          rng.randomFloat(-1e12, 1e12) * dmath.ipow(10, rng.randomInt(-20, 20))
        const text = String(value)
        const back = Number(text)
        const json = JSON.parse(JSON.stringify({ v: value })) as { v: number }
        yield { in: text, out: `${toBitsHex(back)}:${toBitsHex(json.v)}` }
      }
    },
  })

  definitions.push({
    id: "encoding/collections",
    count: 5_000,
    *produce() {
      // Map and Set iterate in insertion order, which is deterministic given
      // the same insertion history. That is the property under test, so the
      // walk is deliberately not sorted.
      const rng = new Prng(`${SEED}:collections`)
      for (let i = 0; i < 5_000; i++) {
        const map = new Map<string, number>()
        const set = new Set<number>()
        for (let j = 0; j < 20; j++) {
          const key = `k${rng.randomInt(0, 12)}`
          map.set(key, rng.randomInt(0, 1000))
          set.add(rng.randomInt(0, 30))
        }
        for (let j = 0; j < 6; j++) {
          map.delete(`k${rng.randomInt(0, 12)}`)
          set.delete(rng.randomInt(0, 30))
        }
        map.set("k0", 1)
        set.add(0)
        const walk = `${[...map.keys()].join(",")}|${[...set].join(",")}`
        yield { in: String(i), out: hash64(walk) }
      }
    },
  })

  definitions.push({
    id: "packs/sha256",
    count: 1_004,
    *produce() {
      const rng = new Prng(`${SEED}:sha256`)
      for (let i = 0; i < 1_000; i++) {
        // Every length to 300 covers each way the padding can fall across a
        // block edge; the rest are longer messages of many blocks.
        const length = i < 300 ? i : rng.randomInt(300, 6_000)
        const bytes = new Uint8Array(length)
        for (let j = 0; j < length; j++) bytes[j] = rng.randomUint32() & 0xff
        yield { in: String(length), out: sha256Hex(bytes) }
      }
      // The length field past 2^29 bytes, which no engine is asked to
      // allocate: the padding of a 37-byte tail written as if the message
      // were 256 MiB, 512 MiB, 512 MiB + 37 and 8 GiB + 5 long.
      const tail = new Uint8Array(37)
      for (let j = 0; j < 37; j++) tail[j] = j
      for (const counted of [
        268_435_456, 536_870_912, 536_870_949, 8_589_934_597,
      ]) {
        yield { in: `tail as ${counted}`, out: sha256Hex(tail, counted) }
      }
    },
  })

  definitions.push({
    id: "packs/utf8",
    count: 3_000,
    *produce() {
      const rng = new Prng(`${SEED}:utf8`)
      for (let i = 0; i < 3_000; i++) {
        const points: number[] = []
        const length = rng.randomInt(0, 40)
        for (let j = 0; j < length; j++) points.push(drawPoint(rng))
        const bytes = encodeUtf8(points)
        // One in ten has a byte replaced, which is usually invalid UTF-8;
        // refusing it is as much a result to agree on as decoding it.
        if (i % 10 === 9 && bytes.length > 0) {
          bytes[rng.randomInt(0, bytes.length - 1)] = rng.randomInt(0x80, 0xff)
        }
        yield {
          in: String(i),
          out: attempt(() => hash64(decodeUtf8(bytes, "probe"))),
        }
      }
    },
  })

  definitions.push({
    id: "packs/json",
    count: 2_000,
    *produce() {
      const rng = new Prng(`${SEED}:json`)
      const escapes = ["\\n", '\\"', "\\\\", "\\u00e9", "\\ud83d\\ude00", "x"]
      for (let i = 0; i < 2_000; i++) {
        const numbers: string[] = []
        for (let j = 0; j < 6; j++) {
          // Up to the 20 significant digits ECMAScript pins, and one in
          // seven documents carries a 21st, which must be refused.
          const digits = i % 7 === 6 && j === 0 ? 21 : rng.randomInt(1, 20)
          numbers.push(drawNumber(rng, digits))
        }
        let text = ""
        for (let j = 0; j < 3; j++) {
          text += escapes[rng.randomInt(0, escapes.length - 1)] as string
        }
        const source = `{"n":[${numbers.join(",")}],"s":"${text}","t":true}`
        const bytes = encodeUtf8(
          [...source].map((c) => c.codePointAt(0) as number),
        )
        yield {
          in: String(i),
          out: attempt(() =>
            hash64(encodeCanonical(decodeJsonPack(bytes, "probe"))),
          ),
        }
      }
    },
  })

  definitions.push({
    id: "sim/reference-1000",
    count: 17,
    *produce() {
      const log = botLog("probe", 1_200)
      const result = runSession({
        module: createReferenceGame(),
        seed: "probe-session",
        config: REFERENCE_CONFIG,
        inputs: new RecordedInputSource(log),
        maxTicks: 1_000,
        checkpointEvery: 60,
        counters: REFERENCE_COUNTERS,
      })
      for (const checkpoint of result.checkpoints) {
        yield { in: String(checkpoint.tick), out: checkpoint.hash }
      }
      yield { in: "counters", out: hash64(encodeCanonical(result.counters)) }
    },
  })

  definitions.push({
    id: "sim/reference-full",
    count: 0,
    heavy: true,
    *produce() {
      for (const seed of ["a", "b", "c"]) {
        const log = botLog(seed, 20_000)
        const result = runSession({
          module: createReferenceGame(),
          seed: `probe-${seed}`,
          config: REFERENCE_CONFIG,
          inputs: new RecordedInputSource(log),
          maxTicks: 18_000,
          checkpointEvery: 60,
          counters: REFERENCE_COUNTERS,
        })
        for (const checkpoint of result.checkpoints) {
          yield { in: `${seed}@${checkpoint.tick}`, out: checkpoint.hash }
        }
        yield {
          in: `${seed}:counters`,
          out: hash64(encodeCanonical(result.counters)),
        }
      }
    },
  })

  return definitions
}

const DEFINITIONS = buildDefinitions()
const BY_ID = new Map(DEFINITIONS.map((d) => [d.id, d]))

export type ProbeVector = {
  readonly id: string
  readonly count: number
  readonly digest: string
  /** The first few results, so a report has something to show without a bisect. */
  readonly head: readonly string[]
}

export type ProbeResult = {
  readonly probeVersion: number
  readonly vectors: readonly ProbeVector[]
}

export function probeVectorIds(
  options: { readonly heavy?: boolean } = {},
): readonly string[] {
  return DEFINITIONS.filter(
    (d) => options.heavy === true || d.heavy !== true,
  ).map((d) => d.id)
}

export function runProbe(
  options: { readonly only?: readonly string[]; readonly heavy?: boolean } = {},
): ProbeResult {
  const wanted = options.only === undefined ? null : new Set(options.only)
  const vectors: ProbeVector[] = []
  for (const definition of DEFINITIONS) {
    if (wanted !== null && !wanted.has(definition.id)) continue
    if (wanted === null && definition.heavy === true && options.heavy !== true)
      continue
    const hasher = new Hash64()
    const head: string[] = []
    let count = 0
    for (const item of definition.produce()) {
      hasher.update(item.out)
      if (head.length < 4) head.push(item.out)
      count++
    }
    vectors.push({ id: definition.id, count, digest: hasher.digest(), head })
  }
  return { probeVersion: PROBE_VERSION, vectors }
}

/**
 * The digest of one slice of one vector.
 *
 * This is the bisect primitive: seventeen of these localise the first
 * differing item in a hundred thousand without sending a hundred thousand
 * values over the wire. A sequential vector is recomputed from the start each
 * time, which is cheap next to the round trip.
 */
export function probeRange(
  id: string,
  from: number,
  to: number,
): { readonly digest: string; readonly count: number } {
  const definition = BY_ID.get(id)
  if (definition === undefined) {
    fail("E_ARG_INVALID", { detail: `no probe vector named ${id}` })
  }
  const hasher = new Hash64()
  let index = 0
  let count = 0
  for (const item of definition.produce()) {
    if (index >= from && index < to) {
      hasher.update(item.out)
      count++
    }
    index++
    if (index >= to) break
  }
  return { digest: hasher.digest(), count }
}

/** Full detail for a narrow slice, asked for only once a divergence is placed. */
export function probeDetail(
  id: string,
  from: number,
  to: number,
): ReadonlyArray<{ readonly index: number } & ProbeItem> {
  const definition = BY_ID.get(id)
  if (definition === undefined) {
    fail("E_ARG_INVALID", { detail: `no probe vector named ${id}` })
  }
  const out: Array<{ index: number } & ProbeItem> = []
  let index = 0
  for (const item of definition.produce()) {
    if (index >= from && index < to) out.push({ index, ...item })
    index++
    if (index >= to) break
  }
  return out
}
