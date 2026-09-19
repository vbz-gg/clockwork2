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

import { toBitsHex } from "../bits"
import * as dmath from "../dmath/index"
import { encodeCanonical } from "../hash/canonical"
import { Hash64, hash64 } from "../hash/hash64"
import { RecordedInputSource } from "../inputs"
import { runSession } from "../loop"
import { Prng } from "../prng/index"
import { botLog } from "../testing/input-logs"
import {
  createReferenceGame,
  REFERENCE_CONFIG,
  REFERENCE_COUNTERS,
} from "../testing/reference-game"

export const PROBE_VERSION = 1

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
  if (definition === undefined) throw new Error(`no probe vector named ${id}`)
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
  if (definition === undefined) throw new Error(`no probe vector named ${id}`)
  const out: Array<{ index: number } & ProbeItem> = []
  let index = 0
  for (const item of definition.produce()) {
    if (index >= from && index < to) out.push({ index, ...item })
    index++
    if (index >= to) break
  }
  return out
}
