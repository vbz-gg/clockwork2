#!/usr/bin/env bun
/**
 * The CHANGELOG section for one version, as a GitHub release body.
 *
 *   bun run scripts/release-notes.ts 0.3.0
 *
 * The release workflow pipes this into `gh release create --notes-file`, so
 * the release notes are the changelog rather than a second description of the
 * same commits written by hand and drifting from it.
 */
import { readFileSync } from "node:fs"

/**
 * A release heading, as commit-and-tag-version writes them.
 *
 * Three shapes, and the parser has to tell all of them from the section
 * headings inside a release. Minor and major releases get `## [0.3.0](compare
 * link) (date)`, a patch gets `### [0.3.1](...)`, and the first release of all
 * has no compare link at all: `## 0.2.0 (date)`. Meanwhile `### Bug Fixes`
 * sits inside a section at the same depth as a patch heading, so depth alone
 * cannot end a section. Requiring a version number after the hashes is what
 * separates them.
 */
export const RELEASE_HEADING = /^#{2,3} \[?(\d+\.\d+\.\d+[^\]\s]*)\]?/

/** Whether the changelog records any release at all. */
export function hasRelease(changelog: string): boolean {
  return changelog.split("\n").some((line) => RELEASE_HEADING.test(line))
}

/**
 * Everything under `version`'s heading, up to the next release heading.
 *
 * The heading line itself is left out, because the GitHub release already
 * carries the version as its title and the compare link as its own metadata.
 *
 * A missing section throws, and so does an empty one. The second used to
 * pass, which made this function's own promise false: 0.6.0 was cut with
 * nothing between its heading and the next, and it published a GitHub release
 * with a blank body. A version with no changelog under it is a version with
 * no reason to exist, and this is the last place to notice before it is
 * announced.
 */
export function sectionFor(changelog: string, version: string): string {
  const lines = changelog.split("\n")
  let start = -1
  let section: string | null = null
  for (const [index, line] of lines.entries()) {
    const heading = RELEASE_HEADING.exec(line)
    if (heading === null) continue
    if (start === -1) {
      if (heading[1] === version) start = index
      continue
    }
    section = lines
      .slice(start + 1, index)
      .join("\n")
      .trim()
    break
  }

  if (start === -1) {
    throw new Error(
      `CHANGELOG.md has no section for ${version}; the release commit writes one, so this version was tagged without it`,
    )
  }

  const body =
    section ??
    lines
      .slice(start + 1)
      .join("\n")
      .trim()

  if (body === "") {
    throw new Error(
      `CHANGELOG.md's section for ${version} is empty, so nothing changed since the version before it; a release with a blank body says nothing about itself`,
    )
  }
  return body
}

if (import.meta.main) {
  const version = process.argv[2]
  if (version === undefined) {
    console.error("usage: bun run scripts/release-notes.ts <version>")
    process.exit(2)
  }
  console.log(sectionFor(readFileSync("CHANGELOG.md", "utf8"), version))
}
