/**
 * Keeps the skill's generated API reference in step with KERNEL_VERSION.
 *
 * This is the same omission `kernel-version-updater.cjs` describes, one layer
 * further out, and it made every release fail rather than only the recordings
 * written after one. `references/kernel-api.md` is generated from the built
 * declarations, so it carries KERNEL_VERSION's literal value, and
 * `skill/tests/skill.test.ts` regenerates it and compares. The gate that would
 * catch a stale file is `.versionrc.json`'s `prerelease` hook, which runs
 * *before* the bump - so it read 0.1.0 against a file saying 0.1.0 and passed.
 * The bump then wrote 0.2.0 into the kernel and left the reference at 0.1.0,
 * and the tag build regenerated, found 0.2.0, and exited 1. Run 35696536750 is
 * that, and it is why 0.2.0 was tagged and never published.
 *
 * Listing the file here puts it in the bump, so the release commit is
 * self-consistent. The generator remains the only thing that writes the rest
 * of the file.
 *
 * CommonJS because commit-and-tag-version loads an updater with require, and
 * the workspace is "type": "module".
 */

const PATTERN = /(KERNEL_VERSION = ")([^"]+)(")/g

function first(contents) {
  const match = new RegExp(PATTERN.source).exec(contents)
  if (match === null) {
    throw new Error(
      'no `KERNEL_VERSION = "..."` in the skill API reference; if ' +
        "gen-skill-api stopped emitting it, drop this file from bumpFiles",
    )
  }
  return match[2]
}

module.exports.readVersion = (contents) => first(contents)

module.exports.writeVersion = (contents, version) => {
  first(contents)
  return contents.replace(PATTERN, `$1${version}$3`)
}
