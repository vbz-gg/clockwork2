#!/usr/bin/env bun
/**
 * The conformance CLI.
 *
 *   clockwork2-validate run ./my-game
 *   clockwork2-validate run ./my-game --only=determinism,restore --json
 *   clockwork2-validate scan ./my-game/src/sim.ts
 */

import { loadSubject } from "./load"
import { formatReport, validate } from "./runner"
import { scanImportGraph } from "./scan/import-graph"

function value(argv: readonly string[], name: string): string | undefined {
  const found = argv.find((a) => a.startsWith(`--${name}=`))
  return found?.slice(name.length + 3)
}

const USAGE = `clockwork2-validate

  run <path>     run the conformance suite against a game
  scan <path>    scan one file and its imports for banned APIs

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
  const report = await validate(subject, {
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
