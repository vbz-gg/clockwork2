/**
 * The guard on the changelog's baseline.
 *
 * This exists because the failure it catches is silent: with no tags,
 * commit-and-tag-version produced a 0.4.0 that re-listed every commit in the
 * repository's history and announced breaking changes from two releases ago,
 * and reported success while doing it.
 */

import { describe, expect, test } from "bun:test"
import { baselineMissing } from "./check-release-baseline"

const RELEASED = `# Changelog

## [0.3.0](https://example.invalid/compare/v0.2.0...v0.3.0) (2026-09-22)

### Bug Fixes

* something
`

const NEVER_RELEASED = `# Changelog

All notable changes to this project will be documented in this file.
`

describe("baselineMissing", () => {
  test("past releases and no tags is the broken state", () => {
    expect(baselineMissing(RELEASED, "")).toBe(true)
    expect(baselineMissing(RELEASED, "\n")).toBe(true)
  })

  test("past releases with a tag present is fine", () => {
    expect(baselineMissing(RELEASED, "v0.3.0\n")).toBe(false)
  })

  /** A repository that has never released has nothing to measure from. */
  test("no releases and no tags is a first release, not a fault", () => {
    expect(baselineMissing(NEVER_RELEASED, "")).toBe(false)
  })

  /**
   * `### Bug Fixes` sits at the same depth as a patch release heading. Reading
   * it as one would make every repository look released, so a changelog with
   * only section headings and no version must not trip the guard.
   */
  test("a section heading is not mistaken for a release", () => {
    expect(baselineMissing("# Changelog\n\n### Bug Fixes\n\n* a\n", "")).toBe(
      false,
    )
  })

  test("a patch heading counts as a release", () => {
    expect(
      baselineMissing("# Changelog\n\n### [0.3.1](https://x/y) (2026)\n", ""),
    ).toBe(true)
  })
})
