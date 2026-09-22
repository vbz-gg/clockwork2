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
  writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { $ } from "bun"

export const PUBLIC_PACKAGES = ["engine"] as const

export type Shipped = {
  readonly name: string
  readonly version: string
  readonly dependencies: Record<string, string>
  readonly files: readonly string[]
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
