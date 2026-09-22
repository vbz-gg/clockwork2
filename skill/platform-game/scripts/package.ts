#!/usr/bin/env bun
/**
 * Hashes a game's assets and checks the manifest declares them.
 *
 * The platform refuses an asset that is not declared, and refuses a
 * declaration whose hash does not match the bytes, so this is the step that
 * turns "it works here" into something a server can verify. It prints the
 * `assets` array to paste into the manifest.
 *
 *   package.ts ./dist                 hash everything under ./dist
 *   package.ts ./dist --manifest=./src/manifest.ts   compare with what is declared
 */

import { createHash } from "node:crypto"
import { readdirSync, readFileSync, statSync } from "node:fs"
import { join, relative, resolve } from "node:path"
import type * as Kernel from "@clockwork2/engine"
import { resolveFrom } from "./_resolve"

function flag(name: string): string | undefined {
  const found = process.argv.find((a) => a.startsWith(`--${name}=`))
  return found?.slice(name.length + 3)
}

function* walk(dir: string): Generator<string> {
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry)
    if (statSync(path).isDirectory()) yield* walk(path)
    else yield path
  }
}

const root = process.argv[2]
if (root === undefined || root.startsWith("--")) {
  console.error("usage: package.ts <dir> [--manifest=<path>]")
  process.exit(2)
}

type Entry = { path: string; sha256: string; bytes: number }
const found: Entry[] = []
for (const file of walk(root)) {
  const bytes = readFileSync(file)
  found.push({
    path: relative(root, file),
    sha256: createHash("sha256").update(bytes).digest("hex"),
    bytes: bytes.length,
  })
}
found.sort((a, b) => a.path.localeCompare(b.path))

const total = found.reduce((sum, entry) => sum + entry.bytes, 0)
console.log(
  JSON.stringify(
    found.map((entry) => ({
      ...entry,
      requiredForSim: false,
      license: "TODO",
    })),
    null,
    2,
  ),
)
console.error(`\n${found.length} files, ${total} bytes`)

const manifestPath = flag("manifest")
if (manifestPath !== undefined) {
  const kernel = await resolveFrom<typeof Kernel>("@clockwork2/engine", root)
  const loaded = (await import(resolve(manifestPath))) as { MANIFEST?: unknown }
  const manifest = kernel.assertManifest(loaded.MANIFEST)
  const declared = new Map(
    (manifest.assets ?? []).map((asset) => [asset.path, asset]),
  )
  let problems = 0
  for (const entry of found) {
    const asset = declared.get(entry.path)
    if (asset === undefined) {
      console.error(`undeclared: ${entry.path}`)
      problems++
    } else if (asset.sha256 !== entry.sha256) {
      console.error(`hash differs: ${entry.path}`)
      problems++
    }
    declared.delete(entry.path)
  }
  for (const path of declared.keys()) {
    console.error(`declared but missing: ${path}`)
    problems++
  }
  if (problems > 0) {
    console.error(`\n${problems} problem(s); check 7 (budgets) will fail this`)
    process.exit(1)
  }
  console.error("every file is declared and every hash matches")
}
