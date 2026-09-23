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

  /**
   * A dispatch has to cut a new version, and #15 is why this is a test.
   *
   * The workflow used to publish whatever version the tree held, expecting a
   * bump to have been run on a laptop first. Dispatching after that merge
   * found 0.4.0 on the registry, skipped, and reported success having
   * released nothing. The bump now happens in the job, and these assertions
   * are what stop it being quietly removed again.
   */
  test("a dispatch bumps, rebuilds and tags the commit it bumped", () => {
    const workflow = readFileSync(
      join(ROOT, ".github/workflows/release.yml"),
      "utf8",
    )
    expect(workflow).toContain("name: Bump the version")
    expect(workflow).toContain("commit-and-tag-version")
    // The bump rewrites KERNEL_VERSION in src, and dist is what ships.
    expect(workflow).toContain("name: Rebuild at the bumped version")
    // The tag names the bump commit rather than the one checked out. The
    // fallback spelling is what says the target is not plain GITHUB_SHA.
    expect(workflow).toContain("RELEASE_SHA:-")
    // Without full history commit-and-tag-version reads the wrong previous
    // tag and re-lists commits that already shipped.
    expect(workflow).toContain("fetch-depth: 0")
  })

  /**
   * A release tells the repositories that pin this engine, and never fails
   * because it could not. By the time that step runs the version is
   * published, tagged and announced, so a missing or expired token must not
   * turn a release that worked into a red run - and every repository it tells
   * also polls the registry daily, which is what makes that a delay rather
   * than a miss.
   */
  test("the release tells its consumers, best-effort", () => {
    const workflow = readFileSync(
      join(ROOT, ".github/workflows/release.yml"),
      "utf8",
    )
    expect(workflow).toContain("event_type=engine-released")
    // GITHUB_TOKEN is scoped to this repository and cannot dispatch to
    // another, so this step reads a token of its own.
    expect(workflow).toContain("secrets.ENGINE_RELEASED_TOKEN")
    expect(workflow).toContain("continue-on-error: true")
    // And it says so when the token is not there, rather than failing.
    expect(workflow).toContain("their daily checks will pick this up")
  })

  /**
   * No majors, in the one place somebody would reach for one. The test above
   * holding the version at 0 is the backstop; this is the door.
   */
  test("the release workflow offers no major bump", () => {
    const workflow = readFileSync(
      join(ROOT, ".github/workflows/release.yml"),
      "utf8",
    )
    const options = /options: \[([^\]]*)\]/.exec(workflow)?.[1] ?? ""
    expect(options).toContain("patch")
    expect(options).toContain("minor")
    expect(options).not.toContain("major")
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
