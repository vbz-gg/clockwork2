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
const RELEASE_HEADING = /^#{2,3} \[?(\d+\.\d+\.\d+[^\]\s]*)\]?/

/**
 * Everything under `version`'s heading, up to the next release heading.
 *
 * The heading line itself is left out, because the GitHub release already
 * carries the version as its title and the compare link as its own metadata.
 */
export function sectionFor(changelog: string, version: string): string {
  const lines = changelog.split("\n")
  let start = -1
  for (const [index, line] of lines.entries()) {
    const heading = RELEASE_HEADING.exec(line)
    if (heading === null) continue
    if (start === -1) {
      if (heading[1] === version) start = index
      continue
    }
    return lines
      .slice(start + 1, index)
      .join("\n")
      .trim()
  }
  if (start === -1) {
    // No sentinel: an empty body would publish a release that says nothing
    // about itself, and nobody would notice until they read it.
    throw new Error(
      `CHANGELOG.md has no section for ${version}; the release commit writes one, so this version was tagged without it`,
    )
  }
  return lines
    .slice(start + 1)
    .join("\n")
    .trim()
}

if (import.meta.main) {
  const version = process.argv[2]
  if (version === undefined) {
    console.error("usage: bun run scripts/release-notes.ts <version>")
    process.exit(2)
  }
  console.log(sectionFor(readFileSync("CHANGELOG.md", "utf8"), version))
}
