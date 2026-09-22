/**
 * The package's public surface, and the one constant nothing was keeping honest.
 *
 * Every other kernel test imports a deep relative path, so until this file the
 * barrels were never loaded by the suite at all. That is not only a coverage
 * gap: a re-export renamed in a submodule leaves an undefined binding that only
 * a consumer discovers, and `bun run check:publishable` packs the tarball
 * without ever importing what is in it.
 *
 * KERNEL_VERSION is the sharper one. It is declared by hand in src/index.ts and
 * written into every Recording.kernelVersion and every frame handshake, and it
 * was not in .versionrc.json's bumpFiles. The next release would have moved the
 * package and left the constant behind, and every recording stored afterwards
 * would have claimed a kernel version that did not produce it.
 */

import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import * as hash from "../../src/hash/index"
import * as kernel from "../../src/index"
import * as testing from "../../src/testing/index"

const ROOT = join(import.meta.dir, "../..")

function packageJson(): { version: string; exports: Record<string, unknown> } {
  return JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")) as {
    version: string
    exports: Record<string, unknown>
  }
}

describe("KERNEL_VERSION", () => {
  test("is the version in the kernel's package.json", () => {
    expect(kernel.KERNEL_VERSION).toBe(packageJson().version)
  })

  test("is a semantic version, since a manifest pins its major", () => {
    expect(kernel.KERNEL_VERSION).toMatch(/^\d+\.\d+\.\d+(?:[-+].*)?$/)
  })

  /**
   * The release is what would break the tie above. This asserts the constant is
   * one of the files commit-and-tag-version rewrites, so the two cannot part
   * company at the moment nobody is looking.
   */
  test("is bumped by the release, not by hand", () => {
    const versionrc = JSON.parse(
      readFileSync(join(ROOT, "../../.versionrc.json"), "utf8"),
    ) as { bumpFiles: Array<string | { filename: string }> }
    const names = versionrc.bumpFiles.map((entry) =>
      typeof entry === "string" ? entry : entry.filename,
    )
    expect(names).toContain("packages/kernel/src/index.ts")
    expect(names).toContain("packages/kernel/package.json")
  })
})

describe("the main barrel", () => {
  /**
   * A name that became undefined still type-checks at the re-export and still
   * packs into the tarball. Importing every one of them is the only thing that
   * finds it here rather than in a consumer's build.
   */
  test("every exported name is defined", () => {
    const undefinedNames = Object.entries(kernel)
      .filter(([, value]) => value === undefined)
      .map(([name]) => name)
    expect(undefinedNames).toEqual([])
  })

  test("carries the pieces a game is written against", () => {
    // Not an inventory of everything: these are the ones docs/engine.md tells a
    // game author to import, so a game following the documentation compiles.
    for (const name of [
      "Prng",
      "Timer",
      "runSession",
      "Session",
      "Accumulator",
      "LiveInputQueue",
      "RecordedInputSource",
      "dmath",
      "fixed",
      "hash64",
      "encodeCanonical",
      "ClockworkError",
      "ERROR_CODES",
      "fail",
      "assertManifest",
      "validateManifest",
      "encodeRecording",
      "decodeRecording",
      "lerp",
      "NodeSet",
      "installShims",
    ]) {
      expect(Object.hasOwn(kernel, name), `missing export ${name}`).toBe(true)
    }
  })

  test("the namespace exports really are namespaces", () => {
    expect(typeof kernel.dmath.sin).toBe("function")
    expect(typeof kernel.fixed.fromNumber).toBe("function")
  })

  test("does not leak a name that is only meant for a subpath", () => {
    // The probe is exported from ./probe alone. Pulling it into the main entry
    // would drag the reference game into every consumer's bundle.
    expect(Object.hasOwn(kernel, "runProbe")).toBe(false)
  })
})

describe("the subpath barrels", () => {
  test("hash exports its whole surface, all defined", () => {
    expect(Object.keys(hash).length).toBeGreaterThan(0)
    expect(Object.values(hash).every((v) => v !== undefined)).toBe(true)
    expect(typeof hash.hash64).toBe("function")
  })

  test("testing exports the fixtures the suites are built on", () => {
    expect(Object.values(testing).every((v) => v !== undefined)).toBe(true)
    for (const name of [
      "createReferenceGame",
      "REFERENCE_MANIFEST",
      "REFERENCE_CONFIG",
      "botLog",
      "chaosLog",
      "idleLog",
      "standardLogs",
      "compareResults",
    ]) {
      expect(Object.hasOwn(testing, name), `missing export ${name}`).toBe(true)
    }
  })

  /**
   * A subpath in the exports map that does not resolve packs happily and fails
   * on the consumer's first import. check-publishable.ts reads the tarball's
   * package.json; nothing imported what the map points at.
   */
  test("every subpath in the exports map resolves to something", async () => {
    const entries = Object.entries(packageJson().exports)
    const importable = entries.filter(([subpath]) => !subpath.endsWith(".json"))
    expect(importable.length).toBeGreaterThan(5)

    for (const [subpath, condition] of importable) {
      const source = (condition as { development?: string }).development
      expect(source, `${subpath} has no development condition`).toBeDefined()
      const module = (await import(join(ROOT, source as string))) as Record<
        string,
        unknown
      >
      expect(
        Object.keys(module).length,
        `${subpath} exported nothing`,
      ).toBeGreaterThan(0)
    }
  })
})
