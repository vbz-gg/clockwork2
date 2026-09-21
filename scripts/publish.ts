/**
 * Publishes every public package, in dependency order, with a token rather
 * than an interactive one-time password. A release cut from a machine is a
 * release nobody else can cut.
 *
 * `bun publish`, not `npm publish`. Cross-package dependencies are declared
 * `workspace:*`, which is what makes the monorepo resolve locally, and npm
 * ships that string verbatim: the tarball would carry
 * `"@clockwork2/kernel": "workspace:*"` and no consumer could install it. Bun
 * replaces it with the version being published.
 * `scripts/check-publishable.ts` packs each one and proves it.
 */
import { $ } from "bun"

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
  console.log(`publishing packages/${pkg}`)
  await $`bun publish --access public`.cwd(`packages/${pkg}`)
}
