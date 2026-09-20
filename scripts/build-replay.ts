/**
 * Bundles the headless replay so Node can run it.
 *
 * Node runs the bundle rather than the TypeScript, so the cross-runtime check
 * compares two engines rather than two ways of getting TypeScript to run.
 */

import { mkdirSync } from "node:fs"

mkdirSync("test-results", { recursive: true })

const built = await Bun.build({
  entrypoints: ["scripts/replay.ts"],
  target: "node",
  format: "esm",
  outdir: "test-results",
  naming: "replay.mjs",
  minify: false,
  sourcemap: "none",
})

if (!built.success) {
  for (const log of built.logs) console.error(String(log))
  process.exit(1)
}
console.log("test-results/replay.mjs")
