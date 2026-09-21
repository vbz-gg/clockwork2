/**
 * The probe's digests, checked on this engine alone.
 *
 * `bun run test:engines` is what proves the digests agree *between* engines.
 * This is the cheap half: it catches a change to the simulation on whichever
 * engine the developer happens to be on, so a deliberate change is noticed
 * before the sweep runs in CI.
 */

import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { probeRange, probeVectorIds, runProbe } from "../../src/probe/index"

const GOLDEN = join(import.meta.dir, "probe-golden.tsv")

const GOLDEN_TEXT = readFileSync(GOLDEN, "utf8")

function readGolden(): Map<string, string> {
  const map = new Map<string, string>()
  for (const raw of GOLDEN_TEXT.split("\n")) {
    // A checkout that rewrote LF to CRLF would otherwise leave a carriage
    // return on the end of every digest, and every vector below would report
    // that the simulation had changed. `.gitattributes` pins the endings; this
    // keeps the failure honest if something else gets past it.
    const line = raw.endsWith("\r") ? raw.slice(0, -1) : raw
    if (line.length === 0 || line.startsWith("#")) continue
    const [id, digest] = line.split("\t")
    if (id !== undefined && digest !== undefined) map.set(id, digest)
  }
  return map
}

// Run once: the probe is a second of work and every test below reads it.
const golden = readGolden()
const result = runProbe()

describe("probe golden digests", () => {
  test("every vector has a recorded digest", () => {
    for (const id of probeVectorIds({ heavy: true })) {
      expect(golden.has(id), `${id} is missing from probe-golden.tsv`).toBe(
        true,
      )
    }
  })

  test("the digests still match", () => {
    for (const vector of result.vectors) {
      expect(vector.digest, `${vector.id} changed`).toBe(
        golden.get(vector.id) as string,
      )
    }
    expect(result.vectors.length).toBeGreaterThan(20)
  })

  test("the file on disk has Unix line endings", () => {
    // `.gitattributes` pins this. A CRLF checkout leaves a carriage return on
    // every digest here and changes the bytes the dmath checksum covers, and
    // the failure it produces accuses the simulation rather than the checkout.
    expect(GOLDEN_TEXT).not.toContain("\r")
  })

  test("every vector produced something", () => {
    for (const vector of result.vectors) {
      expect(vector.count, `${vector.id} produced nothing`).toBeGreaterThan(0)
      expect(vector.head.length).toBeGreaterThan(0)
    }
  })

  test("a range digest of the whole vector equals the vector's digest", () => {
    // The bisect primitive has to agree with the full run, or a divergence
    // hunt walks to the wrong item.
    const vector = result.vectors.find((v) => v.id === "prng/alea-uint32")
    expect(vector).toBeDefined()
    const whole = vector as { count: number; digest: string }
    expect(probeRange("prng/alea-uint32", 0, whole.count).digest).toBe(
      whole.digest,
    )
  })

  test("a range digest of a slice differs from the whole", () => {
    const vector = result.vectors.find((v) => v.id === "prng/alea-uint32") as {
      count: number
      digest: string
    }
    const half = probeRange("prng/alea-uint32", 0, Math.floor(vector.count / 2))
    expect(half.count).toBe(Math.floor(vector.count / 2))
    expect(half.digest).not.toBe(vector.digest)
  })
})
