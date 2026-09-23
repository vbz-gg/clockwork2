/**
 * Reading one release out of the changelog.
 *
 * The failure worth guarding is a section that ends in the wrong place. A
 * parser that stops at the next `###` swallows nothing and stops at `### Bug
 * Fixes`, three lines in; one that only looks for `##` runs a patch release
 * into the release before it. Both produce a GitHub release that looks
 * plausible and is wrong.
 */

import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { sectionFor } from "./release-notes"

const CHANGELOG = `# Changelog

All notable changes to this project will be documented in this file.

### [0.3.1](https://example.invalid/compare/v0.3.0...v0.3.1) (2026-09-23)


### Bug Fixes

* a patch ([abc1234](https://example.invalid/commit/abc1234))

## [0.3.0](https://example.invalid/compare/v0.2.0...v0.3.0) (2026-09-22)


### ⚠ BREAKING CHANGES

* **dmath:** copysign refuses a NaN

### Bug Fixes

* **dmath:** copysign refuses a NaN ([1b11c32](https://example.invalid/commit/1b11c32))

## 0.2.0 (2026-09-22)


### CI

* the first release has no compare link
`

describe("sectionFor", () => {
  test("a patch heading does not run into the release before it", () => {
    const section = sectionFor(CHANGELOG, "0.3.1")
    expect(section).toContain("a patch")
    expect(section).not.toContain("copysign")
    expect(section).not.toContain("0.3.0")
  })

  test("a section is not ended by the ### headings inside it", () => {
    const section = sectionFor(CHANGELOG, "0.3.0")
    expect(section).toContain("BREAKING CHANGES")
    expect(section).toContain("Bug Fixes")
    expect(section).toContain("copysign refuses a NaN")
    expect(section).not.toContain("a patch")
    expect(section).not.toContain("first release has no compare link")
  })

  test("the first release, which has no compare link, is still found", () => {
    expect(sectionFor(CHANGELOG, "0.2.0")).toContain(
      "first release has no compare link",
    )
  })

  test("the last section runs to the end of the file", () => {
    const section = sectionFor(CHANGELOG, "0.2.0")
    expect(section.endsWith("compare link")).toBe(true)
  })

  test("the heading line is left out, since the release carries the title", () => {
    const section = sectionFor(CHANGELOG, "0.3.0")
    expect(section.startsWith("###")).toBe(true)
    expect(section).not.toContain("compare/v0.2.0...v0.3.0")
  })

  test("a version that is not there throws rather than returning nothing", () => {
    expect(() => sectionFor(CHANGELOG, "9.9.9")).toThrow(/no section for 9/)
  })

  /** The real file, so a change to how the changelog is written shows up. */
  test("the repository's own changelog parses", () => {
    const real = readFileSync(
      join(import.meta.dir, "..", "CHANGELOG.md"),
      "utf8",
    )
    const section = sectionFor(real, "0.3.0")
    expect(section.length).toBeGreaterThan(100)
    expect(section).toContain("copysign refuses a NaN")
    expect(section).not.toContain("## 0.2.0")
  })
})

describe("a release with nothing in it", () => {
  /**
   * What actually happened, reduced to its shape. A dispatch on a tree with
   * no commits since the last tag cut 0.6.0, commit-and-tag-version wrote a
   * heading with nothing under it, and this function returned the empty
   * string - so `gh release create` announced a version with a blank body.
   * The doc comment already promised this throws; it did not.
   */
  const EMPTY = `# Changelog

## [0.6.0](https://example.invalid/compare/v0.5.0...v0.6.0) (2026-09-23)

## [0.5.0](https://example.invalid/compare/v0.4.0...v0.5.0) (2026-09-23)


### Features

* something real ([abc1234](https://example.invalid/commit/abc1234))
`

  test("an empty section throws rather than announcing nothing", () => {
    expect(() => sectionFor(EMPTY, "0.6.0")).toThrow(/is empty/)
  })

  test("the release below it still reads", () => {
    expect(sectionFor(EMPTY, "0.5.0")).toContain("something real")
  })

  /** The newest release has no heading after it, so it takes the other path. */
  test("an empty section at the end of the file throws too", () => {
    const trailing = `# Changelog

## [0.5.0](https://example.invalid/compare/v0.4.0...v0.5.0) (2026-09-23)

## [0.6.0](https://example.invalid/compare/v0.5.0...v0.6.0) (2026-09-23)
`
    expect(() => sectionFor(trailing, "0.6.0")).toThrow(/is empty/)
  })

  test("a version the changelog does not mention still throws its own way", () => {
    expect(() => sectionFor(EMPTY, "0.7.0")).toThrow(/no section for/)
  })
})
