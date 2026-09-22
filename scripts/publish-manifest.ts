#!/usr/bin/env bun
/**
 * Turning a workspace package.json into the one that gets published.
 *
 * Cross-package dependencies are declared `workspace:*`, which is what makes
 * the monorepo resolve locally and what no consumer can install. Something has
 * to replace it with a real version before the tarball is built.
 *
 * `bun publish` does that substitution itself, which is why it was reached for
 * first. It also has no `--provenance`, and the release workflow grants
 * `id-token: write` precisely so npm can sign an attestation saying which
 * commit and which workflow built the tarball. Swapping the publisher traded a
 * supply-chain signature for a string replacement. This does the replacement
 * instead, so npm can keep doing the signing.
 */

export type Manifest = {
  name?: string
  version?: string
  dependencies?: Record<string, string>
  peerDependencies?: Record<string, string>
  [key: string]: unknown
}

const WORKSPACE = "workspace:"

/**
 * Replaces every `workspace:` range with `version`.
 *
 * `workspace:*` and `workspace:^` mean "whatever the monorepo holds", which at
 * publish time is the version being published. A `workspace:` range that names
 * something else is a mistake this cannot silently paper over, so it throws.
 */
export function resolveWorkspaceDeps(
  manifest: Manifest,
  version: string,
): Manifest {
  const out: Manifest = { ...manifest }
  for (const field of ["dependencies", "peerDependencies"] as const) {
    const deps = manifest[field]
    if (deps === undefined) continue
    const resolved: Record<string, string> = {}
    for (const [name, range] of Object.entries(deps)) {
      if (!range.startsWith(WORKSPACE)) {
        resolved[name] = range
        continue
      }
      const rest = range.slice(WORKSPACE.length)
      if (rest !== "*" && rest !== "^" && rest !== "~") {
        throw new Error(
          `${manifest.name ?? "package"}: cannot resolve ${name}: "${range}"; only workspace:*, workspace:^ and workspace:~ are understood`,
        )
      }
      resolved[name] = version
    }
    out[field] = resolved
  }
  return out
}

/** True when anything in here would be unpublishable as written. */
export function hasWorkspaceRange(manifest: Manifest): boolean {
  for (const field of ["dependencies", "peerDependencies"] as const) {
    for (const range of Object.values(manifest[field] ?? {})) {
      if (range.startsWith(WORKSPACE)) return true
    }
  }
  return false
}
