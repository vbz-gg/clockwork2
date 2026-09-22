/**
 * The registry check that makes a release re-runnable.
 *
 * Pushing the tag for a version a dispatch already published is the ordinary
 * way to cut a release here, and both triggers run the same workflow, so the
 * second one has to be a no-op rather than a red run. The risk in a check like
 * that is the other direction: one that reads "already published" too eagerly
 * would skip a real release and report success.
 */

import { describe, expect, test } from "bun:test"
import { readsAsPublished } from "./publish"

describe("reading npm view's answer", () => {
  test("the version printed back means it is published", () => {
    expect(readsAsPublished("0.3.0", 0, "0.3.0\n")).toBe(true)
  })

  /**
   * npm 10.9.7 answers a missing version with E404 and a non-zero exit, which
   * the case below covers. Older majors exited 0 and printed nothing, so this
   * stays: treating a successful exit as the signal, rather than the output,
   * would skip every release after the first the day npm goes back to that.
   */
  test("an empty answer means it is not published", () => {
    expect(readsAsPublished("0.3.0", 0, "")).toBe(false)
    expect(readsAsPublished("0.3.0", 0, "\n")).toBe(false)
  })

  /** E404: the package does not exist at all, which is a first publish. */
  test("a non-zero exit means it is not published", () => {
    expect(readsAsPublished("0.3.0", 1, "")).toBe(false)
    expect(readsAsPublished("0.3.0", 1, "0.3.0\n")).toBe(false)
  })

  /**
   * The failure that would be silent. npm resolves a range to a concrete
   * version, so asking for one version and being told about another is a
   * mismatch rather than a hit.
   */
  test("a different version printed back is not a hit", () => {
    expect(readsAsPublished("0.3.0", 0, "0.1.0\n")).toBe(false)
    expect(readsAsPublished("0.3.0", 0, "0.3.1\n")).toBe(false)
    expect(readsAsPublished("0.3.0", 0, "0.3.0-rc.1\n")).toBe(false)
  })

  test("output is compared after trimming, not before", () => {
    expect(readsAsPublished("0.3.0", 0, "  0.3.0  \r\n")).toBe(true)
  })
})

describe("importing the script does not publish", () => {
  /**
   * The script runs `npm publish` at the top level of its own file. Exporting
   * a function from it means a test imports it, so the publish has to sit
   * behind `import.meta.main` or running this suite would release whatever is
   * on disk.
   */
  test("the publish is guarded by import.meta.main", async () => {
    const source = await Bun.file(
      new URL("./publish.ts", import.meta.url),
    ).text()
    expect(source).toContain("if (import.meta.main)")
    const publishLine = source.indexOf("npm publish")
    const guardLine = source.indexOf("if (import.meta.main)")
    expect(publishLine).toBeGreaterThan(-1)
    // The publish lives inside main(), which the guard is what calls.
    expect(guardLine).toBeGreaterThan(publishLine)
    expect(source).toMatch(/async function main\(\)/)
  })
})
