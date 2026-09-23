#!/usr/bin/env bun
/**
 * Packs every public package and reads what a consumer would actually get.
 *
 * The failure this exists for is silent and total. Cross-package dependencies
 * are declared `workspace:*`, which is what makes the monorepo resolve
 * locally; npm ships that string verbatim, so the tarball would carry
 * `"@clockwork2/engine": "workspace:*"` and `npm install` would fail for
 * everyone, forever, on a version that cannot be unpublished after 72 hours.
 * Nothing in a build, a lint or a test sees it.
 *
 * `scripts/publish.ts` rewrites each manifest with `resolveWorkspaceDeps`
 * before calling npm. This packs through that same function, so what it reads
 * is what a release would really ship rather than what a different tool would
 * have shipped.
 *
 *   bun run scripts/check-publishable.ts
 *
 * Exit codes: 0 passed, 1 a package would ship broken, 2 nothing to check.
 */

import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { pathToFileURL } from "node:url"
import { $ } from "bun"

export const PUBLIC_PACKAGES = ["engine"] as const

export type Shipped = {
  readonly name: string
  readonly version: string
  readonly dependencies: Record<string, string>
  readonly files: readonly string[]
  /** What plain node made of every subpath the exports map names. */
  readonly imports: ImportReport
}

type ExportsMap = Record<string, { default?: string } | string>

/** Every subpath in the exports map, and the file it resolves to. */
export function exportTargets(
  exports: ExportsMap | undefined,
): readonly (readonly [string, string])[] {
  const out: [string, string][] = []
  for (const [subpath, target] of Object.entries(exports ?? {})) {
    const file = typeof target === "string" ? target : target.default
    if (file !== undefined) out.push([subpath, file])
  }
  return out
}

/** What `unimportableSubpaths` found, and what it could not ask about. */
export type ImportReport = {
  readonly problems: readonly string[]
  /** Subpaths whose optional peer is not installed here. */
  readonly skipped: readonly string[]
}

/**
 * An error node raises for a bare specifier it cannot resolve.
 *
 * A peer that is not installed in this checkout is not a finding: `pixi.js` is
 * an optional peer and nothing here depends on it, so `/adapter-pixi` cannot
 * be imported on this machine however correct the package is. A relative path
 * node cannot resolve *is* the finding, and it reads "Cannot find module"
 * instead.
 */
const MISSING_PEER = /Cannot find package '([^']+)'/

/**
 * Imports every subpath of an unpacked package with plain node.
 *
 * Bun and every bundler resolve an extensionless relative import; node ESM
 * does not, and `tsc` emits what the source wrote. So a package can build,
 * typecheck, pass its whole suite under bun and still fail on a consumer's
 * first `import` with ERR_MODULE_NOT_FOUND, which is what this repository
 * shipped from 0.1.0 to 0.7.0 and what nothing here could see.
 *
 * The repository's node_modules is linked into the unpacked tree so the
 * optional peers that *are* installed resolve the way they would for somebody
 * who installed them.
 */
export async function unimportableSubpaths(
  packageDir: string,
): Promise<ImportReport> {
  const manifest = JSON.parse(
    readFileSync(join(packageDir, "package.json"), "utf8"),
  ) as { exports?: ExportsMap }

  try {
    symlinkSync(resolve("node_modules"), join(packageDir, "node_modules"))
  } catch {
    // Already there, or a filesystem that will not link. Every subpath with no
    // peer of its own is still checked, which is most of them.
  }

  const problems: string[] = []
  const skipped: string[] = []
  for (const [subpath, file] of exportTargets(manifest.exports)) {
    // A schema and the manifest itself are data. Importing JSON needs an
    // import attribute, and what a consumer does with it is their business.
    if (!file.endsWith(".js")) continue

    const url = pathToFileURL(join(packageDir, file)).href
    const result =
      await $`node --input-type=module -e ${`await import(${JSON.stringify(url)})`}`
        .quiet()
        .nothrow()
    if (result.exitCode === 0) continue

    const stderr = result.stderr.toString()
    const peer = stderr.match(MISSING_PEER)
    if (peer !== null) {
      skipped.push(`${subpath} (${peer[1]} is not installed here)`)
      continue
    }
    const reason =
      stderr
        .split("\n")
        .find((line) => line.includes("Cannot find"))
        ?.trim() ?? stderr.split("\n")[0]?.trim()
    problems.push(`node cannot import "${subpath}": ${reason}`)
  }
  return { problems, skipped }
}

/** Reads the package.json a tarball would carry, not the one on disk. */
export async function pack(pkg: string, into: string): Promise<Shipped> {
  // No rewrite before packing any more. When this was six packages each
  // declared its siblings `workspace:*`, and the publisher substituted the
  // real version on the way out - so a check that packed the manifest on disk
  // was measuring a release nobody performs. One package has no sibling, so
  // what is on disk is what ships.
  await $`npm pack --pack-destination ${into}`.cwd(`packages/${pkg}`).quiet()
  const tarball = [...new Bun.Glob("*.tgz").scanSync(into)][0]
  if (tarball === undefined) throw new Error(`${pkg} produced no tarball`)
  const out = join(into, "unpacked")
  await $`mkdir -p ${out}`.quiet()
  await $`tar -xzf ${join(into, tarball)} -C ${out}`.quiet()
  const manifest = JSON.parse(
    readFileSync(join(out, "package", "package.json"), "utf8"),
  ) as { name: string; version: string; dependencies?: Record<string, string> }
  const files = [...new Bun.Glob("**/*").scanSync(join(out, "package"))]
  return {
    name: manifest.name,
    version: manifest.version,
    dependencies: manifest.dependencies ?? {},
    files,
    imports: await unimportableSubpaths(join(out, "package")),
  }
}

export function problemsWith(shipped: Shipped): string[] {
  const problems: string[] = []
  for (const [name, range] of Object.entries(shipped.dependencies)) {
    if (range.startsWith("workspace:")) {
      problems.push(
        `${shipped.name} would ship ${name}: "${range}", which no consumer can install`,
      )
    }
  }
  // `files` lists README.md, and npm drops a missing entry without failing.
  if (!shipped.files.includes("README.md")) {
    problems.push(`${shipped.name} would ship no README.md`)
  }
  // Without dist there is nothing to import: every exports target is under it.
  if (!shipped.files.some((file) => file.startsWith("dist/"))) {
    problems.push(`${shipped.name} would ship no dist; run "bun run build"`)
  }
  problems.push(...shipped.imports.problems)
  return problems
}

async function main(): Promise<number> {
  if (!existsSync("packages/engine/package.json")) {
    console.error("run this from the repository root")
    return 2
  }
  const found: string[] = []
  for (const pkg of PUBLIC_PACKAGES) {
    const into = mkdtempSync(join(tmpdir(), `cw2-pack-${pkg}-`))
    try {
      const shipped = await pack(pkg, into)
      const problems = problemsWith(shipped)
      found.push(...problems)
      console.log(
        `${problems.length === 0 ? "ok  " : "BAD "} ${shipped.name}@${shipped.version}  ${shipped.files.length} files`,
      )
      for (const note of shipped.imports.skipped) {
        console.log(`     not imported: ${note}`)
      }
    } finally {
      rmSync(into, { recursive: true, force: true })
    }
  }
  if (found.length > 0) {
    console.error("\na package would ship broken:")
    for (const line of found) console.error(`  ${line}`)
    console.error(
      "\nthe manifest on disk is what ships; there is no rewrite step to blame",
    )
    return 1
  }
  console.log("\nthe package would install cleanly")
  return 0
}

if (import.meta.main) process.exit(await main())
