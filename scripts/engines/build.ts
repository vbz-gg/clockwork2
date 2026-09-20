/**
 * Builds the probe bundle once, so every engine runs identical bytes.
 *
 * If each runtime compiled the TypeScript itself, a difference between two
 * transpilers would be indistinguishable from a difference between two
 * engines, which is the one thing this whole exercise exists to tell apart.
 * The bundle's SHA-256 is printed in the report, so "the same bytes ran
 * everywhere" is a stated fact rather than an assumption.
 */

import { createHash } from "node:crypto"

export interface ProbeBundle {
  readonly source: string
  readonly digest: string
}

export async function buildProbeBundle(): Promise<ProbeBundle> {
  const built = await Bun.build({
    entrypoints: [`${import.meta.dir}/probe-entry.ts`],
    target: "browser",
    format: "iife",
    minify: false,
    sourcemap: "none",
  })
  if (!built.success) {
    const messages = built.logs.map((log) => String(log)).join("\n")
    throw new Error(`could not build the probe bundle:\n${messages}`)
  }
  const output = built.outputs[0]
  if (output === undefined)
    throw new Error("the probe build produced no output")
  const source = await output.text()
  return { source, digest: createHash("sha256").update(source).digest("hex") }
}
