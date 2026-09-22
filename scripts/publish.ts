#!/usr/bin/env bun
/**
 * Publishes every public package, in dependency order.
 *
 * Authentication is npm Trusted Publishing: the release workflow grants
 * `id-token: write`, the npm CLI exchanges that OIDC token for a short-lived
 * credential, and npm signs a provenance attestation naming the commit and the
 * workflow that built each tarball. So there is no token to read here, and no
 * `--provenance` flag either - under trusted publishing npm produces the
 * attestation by default, and passing the flag would only break the one case
 * that has no OIDC token: the first publish of a package, which has to come
 * from a laptop because a trusted publisher cannot be configured for a package
 * that does not exist yet.
 *
 * What this script is really for is the rewrite. `bun publish` would
 * substitute the workspace ranges for us, but it has no `--provenance` at
 * 1.3.11 and no trusted-publishing support, so reaching for it trades a
 * supply-chain signature for a string replacement. We do the replacement here
 * instead: rewrite each manifest, publish, put it back.
 *
 * An unrewritten `workspace:*` reaches the registry verbatim and the published
 * version is uninstallable by anyone, permanently, because a version cannot be
 * unpublished after 72 hours. The restore is in a `finally` so a failed
 * publish does not leave a rewritten package.json in the tree.
 */
import { readFileSync, writeFileSync } from "node:fs"
import { $ } from "bun"
import { type Manifest, resolveWorkspaceDeps } from "./publish-manifest"

const ORDER = [
  "kernel",
  "host-bridge",
  "adapter-canvas2d",
  "adapter-pixi",
  "adapter-three",
  "validate",
]

/**
 * Packs and asks the registry to validate, without publishing.
 *
 * Worth knowing what this does not cover: `--dry-run` never reaches the
 * publish endpoint, so it does not exercise the OIDC exchange. A green dry run
 * says the tarballs are right, not that the credential works.
 */
const dryRun = process.argv.includes("--dry-run")

for (const pkg of ORDER) {
  const path = `packages/${pkg}/package.json`
  const original = readFileSync(path, "utf8")
  const manifest = JSON.parse(original) as Manifest
  const version = manifest.version
  if (version === undefined) throw new Error(`${path} has no version`)

  console.log(`${dryRun ? "packing" : "publishing"} packages/${pkg}@${version}`)
  writeFileSync(
    path,
    `${JSON.stringify(resolveWorkspaceDeps(manifest, version), null, 2)}\n`,
  )
  try {
    // `--access public` is still needed: a scoped package is private by
    // default on its first publish.
    await $`npm publish --access public ${dryRun ? ["--dry-run"] : []}`.cwd(
      `packages/${pkg}`,
    )
  } finally {
    writeFileSync(path, original)
  }
}
