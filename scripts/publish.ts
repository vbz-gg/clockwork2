/**
 * Publishes every public package, in dependency order, with a token rather
 * than an interactive one-time password. A release cut from a machine is a
 * release nobody else can cut.
 */
import { $ } from "bun"

const ORDER = [
  "kernel",
  "compat-clockwork1",
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
  await $`npm publish --access public --provenance`.cwd(`packages/${pkg}`)
}
