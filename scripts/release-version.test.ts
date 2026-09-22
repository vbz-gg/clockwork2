/**
 * Every file carrying the kernel's version literal is bumped with it.
 *
 * Twice now a file has held `KERNEL_VERSION = "..."` and been left out of
 * `.versionrc.json`'s bumpFiles. The first was the kernel's own index.ts,
 * caught by reading. The second was the skill's generated API reference, which
 * reached CI: the release gate runs as `prerelease`, before the bump, so it
 * compared an old version against a file holding the same old version and
 * passed, and the tag build then regenerated the reference and exited 1. Every
 * release failed that way, not an occasional one.
 *
 * So rather than fixing the second file, this finds the third.
 */

import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"

const ROOT = join(import.meta.dir, "..")

/** Built by hand so this file does not match its own search. */
const LITERAL = `${"KERNEL"}_VERSION = "`
const PATTERN = new RegExp(`${LITERAL}([^"]+)"`)

interface BumpFile {
  readonly filename: string
  readonly updater: string
}

const versionrc = JSON.parse(
  readFileSync(join(ROOT, ".versionrc.json"), "utf8"),
) as { bumpFiles: Array<string | BumpFile> }

const rootVersion = (
  JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")) as {
    version: string
  }
).version

/**
 * Where the literal may live: checked-in source and the skill's references.
 * `dist` is excluded because it is built from `src` and never committed.
 */
const SEARCHED = ["packages/engine/src", "skill"]

function filesHoldingTheLiteral(): string[] {
  const found: string[] = []
  for (const dir of SEARCHED) {
    for (const rel of new Bun.Glob("**/*.{ts,md}").scanSync(join(ROOT, dir))) {
      const path = join(dir, rel)
      if (PATTERN.test(readFileSync(join(ROOT, path), "utf8"))) {
        found.push(path)
      }
    }
  }
  return found.sort()
}

describe("the kernel version literal", () => {
  test("is somewhere, so a broken search does not pass vacuously", () => {
    expect(filesHoldingTheLiteral().length).toBeGreaterThan(0)
  })

  test("every file holding it is a bumpFile", () => {
    const bumped = new Set(
      versionrc.bumpFiles.map((f) => (typeof f === "string" ? f : f.filename)),
    )
    for (const path of filesHoldingTheLiteral()) {
      expect(
        bumped.has(path),
        `${path} holds the kernel version but is not in .versionrc.json's bumpFiles, so a release would leave it behind`,
      ).toBe(true)
    }
  })

  /**
   * Majors are off the table for now, by decision. On a 0.x version
   * commit-and-tag-version maps a breaking change to a minor, so the ordinary
   * release path cannot reach 1.0.0 by itself; `release:major` was the only
   * script that could and it is gone. This is the backstop, so a 1.0.0 release
   * commit fails CI before anything can be published. Lifting the policy means
   * deleting this test in a diff somebody reads, which is the point of it
   * being a test rather than a sentence in AGENTS.md.
   */
  test("stays on 0.x while major releases are off the table", () => {
    expect(Number(rootVersion.split(".")[0])).toBe(0)
  })

  test("every file holding it agrees with the root package.json", () => {
    for (const path of filesHoldingTheLiteral()) {
      const contents = readFileSync(join(ROOT, path), "utf8")
      const match = PATTERN.exec(contents)
      expect(match?.[1], `${path}`).toBe(rootVersion)
    }
  })

  test("each updater reads back the version its file holds", async () => {
    for (const entry of versionrc.bumpFiles) {
      if (typeof entry === "string") continue
      const updater = (await import(join(ROOT, entry.updater))) as {
        readVersion: (contents: string) => string
        writeVersion: (contents: string, version: string) => string
      }
      const contents = readFileSync(join(ROOT, entry.filename), "utf8")
      expect(updater.readVersion(contents), entry.filename).toBe(rootVersion)
      // And writing a version back is what readVersion then reports, or the
      // bump would silently no-op on a pattern that drifted.
      expect(
        updater.readVersion(updater.writeVersion(contents, "9.9.9")),
        entry.filename,
      ).toBe("9.9.9")
    }
  })
})
