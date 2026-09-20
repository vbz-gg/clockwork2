/**
 * The vendored alea against the published package.
 *
 * `alea` is a devDependency of the workspace root, never of the kernel, so the
 * published kernel manifest has no `dependencies` key at all. This test is the
 * reason the vendored copy can be trusted: if it drifts, the streams part
 * company here rather than in a player's replay.
 */

import { describe, expect, test } from "bun:test"
import { createHash } from "node:crypto"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import Upstream from "alea"
import { toBitsHex } from "../../src/bits"
import { createAlea } from "../../src/prng/alea"

type UpstreamAlea = {
  (): number
  uint32(): number
  fract53(): number
  exportState(): [number, number, number, number]
  importState(state: [number, number, number, number]): void
}

const make = (seed: string | number): UpstreamAlea =>
  new (Upstream as unknown as new (s: string | number) => UpstreamAlea)(seed)

const SEEDS: Array<string | number> = [
  "",
  "0",
  "clockwork2",
  "🎲", // an astral pair, so surrogate handling is covered
  "\uD800", // a lone surrogate
  "a".repeat(1000),
  0,
  -0,
  1,
  -1,
  2 ** 53,
  1e21, // toString gives exponential form
  Number.NaN,
  Number.POSITIVE_INFINITY,
]

describe("vendored alea", () => {
  test("produces the same stream as alea@1.0.1", () => {
    for (const seed of SEEDS) {
      const ours = createAlea(seed as string | number)
      const theirs = make(seed)
      for (let i = 0; i < 10_000; i++) {
        const a = ours()
        const b = theirs()
        if (toBitsHex(a) !== toBitsHex(b)) {
          throw new Error(
            `seed ${JSON.stringify(String(seed))} diverged at draw ${i}: ${toBitsHex(a)} vs ${toBitsHex(b)}`,
          )
        }
      }
    }
  })

  test("uint32 and fract53 match too", () => {
    const ours = createAlea("clockwork2")
    const theirs = make("clockwork2")
    for (let i = 0; i < 1_000; i++) {
      expect(toBitsHex(ours.uint32())).toBe(toBitsHex(theirs.uint32()))
    }
    for (let i = 0; i < 1_000; i++) {
      expect(toBitsHex(ours.fract53())).toBe(toBitsHex(theirs.fract53()))
    }
  })

  test("state exports the same values and resumes the same stream", () => {
    const ours = createAlea("state")
    const theirs = make("state")
    for (let i = 0; i < 997; i++) {
      ours()
      theirs()
    }
    expect(ours.exportState()).toEqual(theirs.exportState())

    // The state has to survive the trip a snapshot actually takes.
    const roundTripped = JSON.parse(JSON.stringify(ours.exportState())) as [
      number,
      number,
      number,
      number,
    ]
    const resumed = createAlea("anything-else")
    resumed.importState(roundTripped)
    for (let i = 0; i < 1_000; i++) {
      expect(toBitsHex(resumed())).toBe(toBitsHex(theirs()))
    }
  })

  test("refuses to run unseeded, where upstream reads the clock", () => {
    // This is the one intended divergence: upstream falls back to +new Date,
    // which is a non-deterministic default in a library about determinism.
    expect(() => createAlea()).toThrow(/E_SEED_REQUIRED/)
    // And upstream really does accept it, so the divergence is not imagined.
    expect(() => new (Upstream as unknown as new () => unknown)()).not.toThrow()
  })

  test("the upstream file has not changed under its pinned version", () => {
    // If npm ever serves different bytes for alea@1.0.1 this fails with a
    // clear cause rather than the parity test failing mysteriously.
    const source = readFileSync("node_modules/alea/alea.js", "utf8")
    const actual = createHash("sha256").update(source).digest("hex")
    const expected = readFileSync(
      join(import.meta.dir, "../../src/prng/alea.upstream.sha256"),
      "utf8",
    ).trim()
    expect(actual).toBe(expected)
  })

  test("the vendored file reads no clock and no global randomness", () => {
    const source = readFileSync(
      join(import.meta.dir, "../../src/prng/alea.ts"),
      "utf8",
    )
    const code = source
      .split("\n")
      .filter(
        (line) =>
          !line.trimStart().startsWith("*") &&
          !line.trimStart().startsWith("/*"),
      )
      .join("\n")
    expect(code).not.toMatch(/Math\.random/)
    expect(code).not.toMatch(/new Date/)
    expect(code).not.toMatch(/Date\.now/)
  })
})
