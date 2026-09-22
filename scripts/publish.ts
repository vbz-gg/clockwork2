#!/usr/bin/env bun
/**
 * Publishes every public package, in dependency order, with a token rather
 * than an interactive one-time password. A release cut from a machine is a
 * release nobody else can cut.
 *
 * `npm publish --provenance`, and the release workflow grants `id-token:
 * write` so npm can sign an attestation naming the commit and the workflow
 * that built each tarball. `bun publish` would substitute the workspace
 * ranges for us and has no `--provenance` at 1.3.11, so it buys a string
 * replacement at the price of a supply-chain signature. We do the replacement
 * here instead: rewrite each manifest, publish, put it back.
 *
 * The restore is in a finally so a failed publish does not leave a rewritten
 * package.json in the tree.
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

if (!process.env.NODE_AUTH_TOKEN) {
  console.error("NODE_AUTH_TOKEN is not set")
  process.exit(1)
}

for (const pkg of ORDER) {
  const path = `packages/${pkg}/package.json`
  const original = readFileSync(path, "utf8")
  const manifest = JSON.parse(original) as Manifest
  const version = manifest.version
  if (version === undefined) throw new Error(`${path} has no version`)

  console.log(`publishing packages/${pkg}@${version}`)
  writeFileSync(
    path,
    `${JSON.stringify(resolveWorkspaceDeps(manifest, version), null, 2)}\n`,
  )
  try {
    await $`npm publish --access public --provenance`.cwd(`packages/${pkg}`)
  } finally {
    writeFileSync(path, original)
  }
}
