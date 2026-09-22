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
 *
 * Publishing a version the registry already has is not an error here, it is a
 * no-op. Both of the release workflow's triggers can reach the same version:
 * dispatching a publish and then pushing the matching tag is the ordinary way
 * to cut a release, and it would otherwise end in a red run whose only finding
 * is that the release already worked. Re-running a release is the other one.
 */
import { readFileSync } from "node:fs"
import { $ } from "bun"

const PACKAGE_DIR = "packages/engine"

/**
 * Whether `npm view <name>@<version> version` says the registry has it.
 *
 * Measured on npm 10.9.7: a version that is there prints itself and exits 0.
 * A version that is not there exits 1 with E404, and so does a package that
 * does not exist at all, which is a package's first publish. Older npm majors
 * answered the middle case with an empty stdout and a 0 exit, so the exit code
 * alone is not a stable signal and the printed version is compared too.
 *
 * Either way, anything but an exact match falls through to the publish and
 * lets npm decide, which is the direction this check has to fail in. A broken
 * check can then cost an attempted publish that npm refuses. It can never
 * silently skip a release that should have happened.
 */
export function readsAsPublished(
  version: string,
  exitCode: number,
  stdout: string,
): boolean {
  return exitCode === 0 && stdout.trim() === version
}

async function onRegistry(name: string, version: string): Promise<boolean> {
  const result = await $`npm view ${`${name}@${version}`} version`
    .nothrow()
    .quiet()
  return readsAsPublished(version, result.exitCode, result.stdout.toString())
}

async function main(): Promise<number> {
  /**
   * Packs and asks the registry to validate, without publishing.
   *
   * Worth knowing what this does not cover: `--dry-run` never reaches the
   * publish endpoint, so it does not exercise the OIDC exchange. A green dry
   * run says the tarball is right, not that the credential works.
   */
  const dryRun = process.argv.includes("--dry-run")

  /**
   * A one-time password, for a publish from a laptop.
   *
   * CI never needs this: trusted publishing exchanges an OIDC token and npm
   * asks for nothing. A human with 2FA does, and `npm publish` cannot prompt
   * for it from here because Bun's `$` allocates no TTY - so it fails with
   * EOTP after packing, which reads like the publish went wrong rather than
   * like a missing argument. Pass it through instead:
   * `bun run scripts/publish.ts --otp=123456`.
   */
  const otp = process.argv.find((a) => a.startsWith("--otp="))

  const { name, version } = JSON.parse(
    readFileSync(`${PACKAGE_DIR}/package.json`, "utf8"),
  ) as { name: string; version: string }

  if (await onRegistry(name, version)) {
    // A dry run still packs, because that is the whole of what it was asked to
    // do and the tarball is worth validating either way.
    console.log(`${name}@${version} is already on the registry`)
    if (!dryRun) {
      console.log("nothing to publish; bump the version to release again")
      return 0
    }
  }

  console.log(`${dryRun ? "packing" : "publishing"} ${name}@${version}`)
  // `--access public` is still needed: a scoped package is private by default
  // on its first publish.
  await $`npm publish --access public ${dryRun ? ["--dry-run"] : []} ${
    otp === undefined ? [] : [otp]
  }`.cwd(PACKAGE_DIR)
  return 0
}

if (import.meta.main) process.exit(await main())
