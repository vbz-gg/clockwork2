#!/usr/bin/env bun
/**
 * Copies a template into a new directory and renames it.
 *
 *   new.ts ./my-game                  the canvas2d template
 *   new.ts ./my-game --renderer=three
 *
 * The copy passes `validate` before a line of it is changed, which is the
 * point: start from something that conforms and keep it conforming, rather
 * than writing a game and finding out at submission time.
 */

import { cpSync, existsSync, readFileSync, writeFileSync } from "node:fs"
import { basename, join, resolve } from "node:path"

function flag(name: string, fallback: string): string {
  const found = process.argv.find((a) => a.startsWith(`--${name}=`))
  return found === undefined ? fallback : found.slice(name.length + 3)
}

const target = process.argv[2]
if (target === undefined || target.startsWith("--")) {
  console.error("usage: new.ts <dir> [--renderer=canvas2d|three]")
  process.exit(2)
}

const renderer = flag("renderer", "canvas2d")
if (renderer !== "canvas2d" && renderer !== "three") {
  console.error(`unknown renderer ${renderer}; canvas2d or three`)
  process.exit(2)
}

const source = join(import.meta.dir, "../assets/templates", renderer)
const destination = resolve(target)
if (existsSync(destination)) {
  console.error(`${destination} already exists`)
  process.exit(2)
}

cpSync(source, destination, { recursive: true })

/** A game id is immutable once published, so it is set here and not later. */
const id = basename(destination)
  .toLowerCase()
  .replace(/[^a-z0-9-]+/g, "-")
  .replace(/^-|-$/g, "")

for (const file of ["package.json", "src/manifest.ts", "index.html"]) {
  const path = join(destination, file)
  const before = readFileSync(path, "utf8")
  const after = before
    .replace(/lane-runner-3d/g, id)
    .replace(/lane-runner/g, id)
    .replace(/Lane Runner 3D/g, id)
    .replace(/Lane Runner/g, id)
  if (after !== before) writeFileSync(path, after)
}

console.log(`${destination}

  cd ${target}
  bun install
  bun run validate     # passes now, and has to keep passing
  bun run dev
`)
