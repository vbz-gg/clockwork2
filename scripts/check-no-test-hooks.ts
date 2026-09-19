/**
 * Proves a production build of the demo carries no test hooks.
 *
 * The hooks are behind `import.meta.env.VITE_CW2_TEST`, which the bundler
 * replaces at build time, so the dynamic import that loads them is dead code
 * and the module goes. That is how it is meant to work; this is how we find
 * out whether it still does. A bundler flag nobody verifies is a bundler flag
 * that eventually stops working, and the failure is silent: shipping a page
 * that lets anyone drive the simulation from the console.
 *
 *   bun run scripts/check-no-test-hooks.ts [dir]
 */

import { readdirSync, readFileSync, statSync } from "node:fs"
import { join } from "node:path"

const FORBIDDEN = [
  "__cw2test",
  "installTestApi",
  "runFixedLog",
  "restoreAndContinue",
]

function* walk(dir: string): Generator<string> {
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry)
    if (statSync(path).isDirectory()) yield* walk(path)
    else if (path.endsWith(".js") || path.endsWith(".html")) yield path
  }
}

const root = process.argv[2] ?? "demo/dist"
let scanned = 0
const found: string[] = []

try {
  statSync(root)
} catch {
  console.error(`${root} is not there; run "bun run demo:build" first`)
  process.exit(3)
}

for (const file of walk(root)) {
  scanned++
  const source = readFileSync(file, "utf8")
  for (const token of FORBIDDEN) {
    if (source.includes(token)) found.push(`${file}: ${token}`)
  }
}

if (found.length > 0) {
  console.error("a production build carries test hooks:")
  for (const line of found) console.error(`  ${line}`)
  console.error(
    "\nbuild without VITE_CW2_TEST=1, or check that the flag still reaches the bundler",
  )
  process.exit(1)
}
console.log(`no test hooks in ${scanned} built files under ${root}`)
