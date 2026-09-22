/**
 * Holds the aggregate coverage floor across `packages/*`.
 *
 * bunfig.toml's `coverageThreshold` cannot do this job. Bun applies it per
 * file, so a floor of 0.99 there demands 99% of every file, which for a file
 * under a hundred executable lines means 100%. The per-file value in
 * bunfig.toml is therefore a lower safety net that catches one file falling off
 * a cliff, and the number the project actually promises is the aggregate,
 * checked here.
 *
 * Bun writes coverage/lcov.info when `coverageReporter` includes "lcov", and
 * honours `coveragePathIgnorePatterns` there as well as in the text table, so
 * the records this reads are already scoped to package sources.
 *
 * One thing this cannot see, and no aggregate over lcov can: bun reports a file
 * only if the run loaded it. Gutting a test file so it imports a module without
 * exercising it fails this gate loudly, because the module is still in the
 * denominator with nothing covered. Deleting the test file outright does not,
 * because the module then goes with it. Coverage answers "of the code that ran,
 * how much was reached", and a package whose tests are gone has no code that
 * ran. What catches that is review, and `bun run test` reporting fewer tests.
 *
 *   bun test --coverage packages/ scripts/ demo/ skill/
 *   bun run scripts/check-coverage.ts
 *
 * Exit codes: 0 at or above the floor, 1 below it, 2 no readable lcov.
 */

import { readFileSync } from "node:fs"

export const LCOV = "coverage/lcov.info"

/** Lines is what the project promises. */
export const MIN_LINES = 0.99

/**
 * Functions sits lower on purpose. Bun counts every arrow in an options object
 * and every getter, so one uncalled getter moves this number several points on
 * a small file while moving lines by one. It is a floor, not the target: raise
 * it to just under the measurement whenever the measurement rises, because a
 * floor far below what the suite achieves has stopped being a gate. The suite
 * is at 96.70%.
 */
export const MIN_FUNCTIONS = 0.96

export interface FileCoverage {
  readonly path: string
  readonly linesFound: number
  readonly linesHit: number
  readonly functionsFound: number
  readonly functionsHit: number
}

export interface Totals {
  readonly linesFound: number
  readonly linesHit: number
  readonly functionsFound: number
  readonly functionsHit: number
}

function field(record: string, key: string): number {
  const match = record.match(new RegExp(`^${key}:(\\d+)\\r?$`, "m"))
  return match === null ? 0 : Number(match[1])
}

/**
 * Reads the subset of lcov this gate needs: one record per file, with the
 * found and hit counts lcov calls LF/LH and FNF/FNH. The per-line DA rows are
 * ignored; a reviewer who wants them has the artifact.
 *
 * The counts tolerate a trailing carriage return. Bun writes LF today, but a
 * gate that reports 0% because the file arrived with CRLF endings would send
 * whoever hit it looking in the wrong place entirely.
 */
export function parseLcov(text: string): FileCoverage[] {
  const files: FileCoverage[] = []
  for (const record of text.split("end_of_record")) {
    const source = record.match(/^SF:(.*)$/m)
    if (source === null) continue
    files.push({
      path: (source[1] as string).trim(),
      linesFound: field(record, "LF"),
      linesHit: field(record, "LH"),
      functionsFound: field(record, "FNF"),
      functionsHit: field(record, "FNH"),
    })
  }
  return files
}

export function total(files: readonly FileCoverage[]): Totals {
  return files.reduce<Totals>(
    (sum, file) => ({
      linesFound: sum.linesFound + file.linesFound,
      linesHit: sum.linesHit + file.linesHit,
      functionsFound: sum.functionsFound + file.functionsFound,
      functionsHit: sum.functionsHit + file.functionsHit,
    }),
    { linesFound: 0, linesHit: 0, functionsFound: 0, functionsHit: 0 },
  )
}

/** Zero found counts as covered, so an empty report cannot fail on a divide. */
export function ratio(hit: number, found: number): number {
  return found === 0 ? 1 : hit / found
}

/**
 * How many more lines have to be covered to reach the floor. Reported because
 * "89.2%" does not tell anyone how much work is left and "58 lines" does.
 */
export function linesShort(totals: Totals, floor = MIN_LINES): number {
  const needed = Math.ceil(floor * totals.linesFound)
  return Math.max(0, needed - totals.linesHit)
}

export function worstFiles(
  files: readonly FileCoverage[],
  count: number,
): FileCoverage[] {
  return [...files]
    .filter((file) => file.linesFound > file.linesHit)
    .sort(
      (a, b) =>
        b.linesFound - b.linesHit - (a.linesFound - a.linesHit) ||
        a.path.localeCompare(b.path),
    )
    .slice(0, count)
}

function percent(hit: number, found: number): string {
  return `${(100 * ratio(hit, found)).toFixed(2)}%`
}

function main(): void {
  let text: string
  try {
    text = readFileSync(LCOV, "utf8")
  } catch {
    console.error(`\nno ${LCOV}. Run the coverage suite first:\n`)
    console.error("  bun test --coverage packages/ scripts/ demo/ skill/\n")
    process.exit(2)
  }

  const files = parseLcov(text)
  if (files.length === 0) {
    console.error(`\n${LCOV} holds no file records.`)
    console.error("Either bun changed the format or this parser is broken.\n")
    process.exit(2)
  }

  const totals = total(files)
  const lines = ratio(totals.linesHit, totals.linesFound)
  const functions = ratio(totals.functionsHit, totals.functionsFound)

  console.log(
    `coverage over ${files.length} files: ` +
      `lines ${totals.linesHit}/${totals.linesFound} ` +
      `(${percent(totals.linesHit, totals.linesFound)}), ` +
      `functions ${totals.functionsHit}/${totals.functionsFound} ` +
      `(${percent(totals.functionsHit, totals.functionsFound)})`,
  )

  if (lines >= MIN_LINES && functions >= MIN_FUNCTIONS) return

  console.error("")
  if (lines < MIN_LINES) {
    console.error(
      `lines ${percent(totals.linesHit, totals.linesFound)} is below ` +
        `${(100 * MIN_LINES).toFixed(0)}%: ` +
        `${linesShort(totals)} more lines have to be covered`,
    )
  }
  if (functions < MIN_FUNCTIONS) {
    console.error(
      `functions ${percent(totals.functionsHit, totals.functionsFound)} is ` +
        `below ${(100 * MIN_FUNCTIONS).toFixed(0)}%`,
    )
  }

  const worst = worstFiles(files, 10)
  if (worst.length > 0) {
    console.error("\nmost uncovered lines:\n")
    for (const file of worst) {
      const missing = String(file.linesFound - file.linesHit).padStart(4)
      const rate = percent(file.linesHit, file.linesFound).padStart(7)
      console.error(`  ${missing}  ${rate}  ${file.path}`)
    }
  }

  console.error(
    "\nThe way past this is a test for a concrete failure mode, or a path",
  )
  console.error(
    "excluded in bunfig.toml with a written reason. A test that calls a",
  )
  console.error("function and asserts it returned is not either of those.\n")
  process.exit(1)
}

if (import.meta.main) main()
