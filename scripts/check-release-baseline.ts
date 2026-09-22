#!/usr/bin/env bun
/**
 * Refuses a release that has no tag to measure itself from.
 *
 * commit-and-tag-version works out what is unreleased from git tags, not from
 * package.json. With no tag in the repository it treats the whole history as
 * unreleased: the new section re-lists every commit ever made, re-announces
 * every breaking change, and the recommended bump comes back a minor or a
 * major instead of a patch.
 *
 * That happened here. v0.2.0 was deleted as stale, v0.3.0 had never been
 * pushed, and a `bun run release` that should have produced 0.3.1 with three
 * CI lines produced 0.4.0 carrying the entire history back to the Clockwork 1
 * removal. Nothing failed; the output simply looked like a big release.
 *
 * A repository whose changelog records no release yet has nothing to measure
 * from and is fine, so the refusal is specifically: the changelog says
 * releases have happened, and no tag exists to say where the last one ended.
 */
import { readFileSync } from "node:fs"
import { $ } from "bun"
import { hasRelease } from "./release-notes"

export function baselineMissing(changelog: string, tags: string): boolean {
  return hasRelease(changelog) && tags.trim() === ""
}

async function main(): Promise<number> {
  const changelog = readFileSync("CHANGELOG.md", "utf8")
  const tags = (await $`git tag -l`.quiet()).stdout.toString()
  if (!baselineMissing(changelog, tags)) return 0
  console.error(
    [
      "CHANGELOG.md records past releases and this repository has no tags.",
      "",
      "commit-and-tag-version reads git tags to find what is unreleased, so it",
      "would treat every commit ever made as part of this release: the wrong",
      "version, and a changelog section re-listing the whole history.",
      "",
      "Fetch the tags, or recreate the last release's tag at its own commit:",
      "  git fetch origin --tags",
      "  git tag -a vX.Y.Z -m 'chore(release): X.Y.Z' <the release commit>",
    ].join("\n"),
  )
  return 1
}

if (import.meta.main) process.exit(await main())
