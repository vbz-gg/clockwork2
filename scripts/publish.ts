#!/usr/bin/env bun
/**
 * Publishes `@clockwork2/engine`.
 *
 * Authentication is npm Trusted Publishing: the release workflow grants
 * `id-token: write`, the npm CLI exchanges that OIDC token for a short-lived
 * credential, and npm signs a provenance attestation naming the commit and the
 * workflow that built the tarball. So there is no token to read here, and no
 * `--provenance` flag either - under trusted publishing npm produces the
 * attestation by default, and passing it would break the one case with no OIDC
 * token, which is a package's first publish from a laptop.
 *
 * This used to rewrite six package.json files, substituting each `workspace:*`
 * range for the version being published and restoring the file afterwards. An
 * unrewritten range reaches the registry verbatim and that version is
 * uninstallable by anyone, permanently, because nothing can be unpublished
 * after 72 hours. One package has no sibling to depend on, so the rewrite and
 * the hazard are both gone.
 */
import { $ } from "bun"

/**
 * Packs and asks the registry to validate, without publishing.
 *
 * Worth knowing what this does not cover: `--dry-run` never reaches the
 * publish endpoint, so it does not exercise the OIDC exchange. A green dry run
 * says the tarball is right, not that the credential works.
 */
const dryRun = process.argv.includes("--dry-run")

console.log(`${dryRun ? "packing" : "publishing"} @clockwork2/engine`)
// `--access public` is still needed: a scoped package is private by default on
// its first publish.
await $`npm publish --access public ${dryRun ? ["--dry-run"] : []}`.cwd(
  "packages/engine",
)
