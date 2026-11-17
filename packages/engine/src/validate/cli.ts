#!/usr/bin/env bun
/**
 * The conformance CLI.
 *
 *   clockwork2-validate run ./my-game
 *   clockwork2-validate run ./my-game --ranked
 *   clockwork2-validate run ./my-game --only=determinism,restore --json
 *   clockwork2-validate scan ./my-game/src/sim.ts
 */

import { isClockworkError } from "../index.js"
import { loadSubject } from "./load.js"
import { formatReport, validate } from "./runner.js"
import { scanImportGraph } from "./scan/import-graph.js"
import type { Report } from "./types.js"

function value(argv: readonly string[], name: string): string | undefined {
  const found = argv.find((a) => a.startsWith(`--${name}=`))
  return found?.slice(name.length + 3)
}

const USAGE = `clockwork2-validate

  run <path>     run the checks every game needs against a game
  scan <path>    scan one file and its imports for banned APIs

  --ranked       also run the checks a ranked or practice run needs
  --only=a,b     run only these checks
  --seeds=a,b    use these seeds instead of the defaults
  --json         print the report as JSON
`

async function main(argv: readonly string[]): Promise<number> {
  const [command, target] = argv
  if (command === undefined || target === undefined) {
    console.log(USAGE)
    return command === undefined ? 0 : 2
  }

  if (command === "scan") {
    const result = scanImportGraph(target)
    for (const finding of result.findings) {
      console.log(
        `${finding.file}:${finding.line}:${finding.column}  ${finding.kind.padEnd(9)} ${finding.name}  ${finding.why}`,
      )
    }
    console.log(
      `\n${result.files.length} files, ${result.findings.length} finding(s), ${result.trusted.length} platform package(s) trusted`,
    )
    for (const specifier of result.unresolved) {
      console.log(`unresolved: ${specifier}`)
    }
    return result.findings.length === 0 ? 0 : 1
  }

  if (command !== "run") {
    console.error(`unknown command ${command}\n\n${USAGE}`)
    return 2
  }

  const only = value(argv, "only")
  const seeds = value(argv, "seeds")
  const asJson = argv.includes("--json")
  const subject = await loadSubject(target)
  let report: Report
  try {
    report = await validate(subject, {
      set: argv.includes("--ranked") ? "ranked" : "every-game",
      ...(only === undefined ? {} : { only: only.split(",") }),
      ...(seeds === undefined ? {} : { seeds: seeds.split(",") }),
      ...(asJson
        ? {}
        : {
            onProgress: (name: string) => {
              process.stderr.write(`  ${name}...\r`)
            },
          }),
    })
  } catch (error) {
    // An --only naming a check the set does not run is a bad argument, which
    // validate refuses before running anything.
    if (isClockworkError(error) && error.code === "E_ARG_INVALID") {
      console.error(`${error.message}\n\n${USAGE}`)
      return 2
    }
    throw error
  }

  if (asJson) {
    console.log(JSON.stringify(report, null, 2))
  } else {
    process.stderr.write("            \r")
    console.log(formatReport(report))
  }
  return report.ok ? 0 : 1
}

main(process.argv.slice(2))
  .then((code) => process.exit(code))
  .catch((error: unknown) => {
    console.error(error)
    process.exit(3)
  })
