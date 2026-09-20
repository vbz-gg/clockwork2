/**
 * Proves the skill's failure-modes reference still has one section per error
 * code, and no section for a code that no longer exists.
 *
 * skill/tests/skill.test.ts asserts the same thing by importing ERROR_CODES
 * from the built kernel, which needs `bun run build` first and so only runs in
 * CI. This reads the two files as text instead, in milliseconds, from the git
 * index, so a commit that adds a code without explaining it is refused at the
 * point it is made rather than a CI round later.
 *
 *   bun run scripts/check-failure-modes.ts
 *
 * Exit codes: 0 passed, 1 drifted, 2 a file or a parser gave nothing.
 */

import { execSync } from "node:child_process"
import { readFileSync } from "node:fs"

export const ERRORS_SOURCE = "packages/kernel/src/errors.ts"
export const REFERENCE = "skill/platform-game/references/failure-modes.md"

/**
 * Reads what this commit will contain: the staged blob where there is one, and
 * the working tree otherwise. Checking the file on disk instead would pass a
 * commit that stages only half of a rename.
 */
export function readStagedOrDisk(
  path: string,
  staged: readonly string[],
): string {
  if (!staged.includes(path)) return readFileSync(path, "utf8")
  return execSync(`git show :${path}`, { encoding: "utf8", maxBuffer: 1 << 24 })
}

/** Drops comments, so a code named in prose cannot be read as a declaration. */
function withoutComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "")
}

export function codesInSource(source: string): string[] {
  const start = source.indexOf("export const ERROR_CODES")
  if (start === -1) return []
  const end = source.indexOf("} as const", start)
  const block = withoutComments(
    source.slice(start, end === -1 ? undefined : end),
  )
  return [...block.matchAll(/^\s*(E_[A-Z0-9_]+)\s*:/gm)].map(
    (m) => m[1] as string,
  )
}

export function codesInReference(markdown: string): string[] {
  return [...markdown.matchAll(/^### (E_[A-Z0-9_]+)\s*$/gm)].map(
    (m) => m[1] as string,
  )
}

export interface Drift {
  readonly undocumented: string[]
  readonly stale: string[]
  readonly duplicated: string[]
}

export function compare(
  codes: readonly string[],
  sections: readonly string[],
): Drift {
  const documented = new Set(sections)
  const declared = new Set(codes)
  const seen = new Set<string>()
  const duplicated: string[] = []
  for (const section of sections) {
    if (seen.has(section)) duplicated.push(section)
    seen.add(section)
  }
  return {
    undocumented: codes.filter((c) => !documented.has(c)),
    stale: sections.filter((s) => !declared.has(s)),
    duplicated,
  }
}

function main(): void {
  const staged = execSync("git diff --cached --name-only", { encoding: "utf8" })
    .split("\n")
    .filter(Boolean)

  const codes = codesInSource(readStagedOrDisk(ERRORS_SOURCE, staged))
  const sections = codesInReference(readStagedOrDisk(REFERENCE, staged))

  // A regex that quietly stops matching would pass every commit from here on,
  // which is the one failure this script cannot be allowed to have.
  if (codes.length === 0) {
    console.error(`read no error codes out of ${ERRORS_SOURCE}.`)
    console.error(
      "Either the ERROR_CODES table moved or this parser is broken.",
    )
    process.exit(2)
  }
  if (sections.length === 0) {
    console.error(`read no "### E_" sections out of ${REFERENCE}.`)
    console.error(
      "Either the reference changed shape or this parser is broken.",
    )
    process.exit(2)
  }

  const drift = compare(codes, sections)
  const clean =
    drift.undocumented.length === 0 &&
    drift.stale.length === 0 &&
    drift.duplicated.length === 0
  if (clean) return

  console.error(`\ncommit rejected: ${REFERENCE} does not match ERROR_CODES\n`)
  for (const code of drift.undocumented) {
    console.error(`  ${code} has no "### ${code}" section`)
  }
  for (const code of drift.stale) {
    console.error(`  ${code} has a section but is not an error code`)
  }
  for (const code of drift.duplicated) {
    console.error(`  ${code} has more than one section`)
  }
  console.error(
    "\nA code a reader cannot look up is a code they cannot act on. Add the",
  )
  console.error("section, or drop it with the code. Never pass --no-verify.\n")
  process.exit(1)
}

if (import.meta.main) main()
