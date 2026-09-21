/**
 * The probe's golden digests, on disk.
 *
 * The file is a two-column TSV, so how it is split into lines decides what
 * every reader of it sees. Convert it to CRLF and the old parser, which split
 * on `"\n"`, kept a carriage return on the end of each digest: nothing matched,
 * and `scripts/engines.ts` exited 1 reporting all 23 non-heavy vectors as
 * changed on a commit that had not touched the simulation. `core.autocrlf` is
 * true on the GitHub Windows runners, so a Windows checkout produced exactly
 * that file until `.gitattributes` existed.
 *
 * `.gitattributes` now pins text to LF, which is the fix: `dmath-golden.tsv`
 * is checked against a recorded SHA-256 of its bytes and no amount of parsing
 * care would save that one. The parser drops a stray carriage return anyway,
 * because the failure it produces accuses the simulation of a change it did
 * not make.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { dirname } from "node:path"
import type { ProbeAnswer } from "./run"

export const GOLDEN = "packages/kernel/tests/probe/probe-golden.tsv"

/** Vector id to digest. Comments and blank lines are skipped. */
export function parseGolden(text: string): Map<string, string> {
  const map = new Map<string, string>()
  for (const raw of text.split("\n")) {
    const line = raw.endsWith("\r") ? raw.slice(0, -1) : raw
    if (line.length === 0 || line.startsWith("#")) continue
    const [id, digest] = line.split("\t")
    if (id !== undefined && digest !== undefined) map.set(id, digest)
  }
  return map
}

export function readGolden(): Map<string, string> {
  if (!existsSync(GOLDEN)) return new Map()
  return parseGolden(readFileSync(GOLDEN, "utf8"))
}

export function writeGolden(vectors: ProbeAnswer["vectors"]): void {
  mkdirSync(dirname(GOLDEN), { recursive: true })
  const lines = [
    "# Cross-engine probe digests. Written by scripts/engines.ts --update.",
    "# A change here means the simulation changed. Say why in the commit body.",
    ...vectors.map((v) => `${v.id}\t${v.digest}`),
  ]
  writeFileSync(GOLDEN, `${lines.join("\n")}\n`)
}
