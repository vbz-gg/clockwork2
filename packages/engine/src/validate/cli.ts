#!/usr/bin/env bun
/**
 * The conformance CLI.
 *
 *   clockwork2-validate run ./my-game
 *   clockwork2-validate run ./my-game --ranked
 *   clockwork2-validate run ./my-game --only=determinism,restore --json
 *   clockwork2-validate scan ./my-game/src/sim.ts
 */

import { type ParseArgsConfig, parseArgs } from "node:util"
import { isClockworkError } from "../index.js"
import { loadSubject } from "./load.js"
import { CHECK_NAME_WIDTH, formatReport, validate } from "./runner.js"
import { scanImportGraph } from "./scan/import-graph.js"
import type { Report } from "./types.js"

const USAGE = `clockwork2-validate

  run <path>     run the checks every game needs against a game
  scan <path>    scan one file and its imports for banned APIs

  --ranked       also run the checks a ranked or practice run needs
  --only=a,b     run only these checks
  --seeds=a,b    use these seeds instead of the defaults
  --json         print the report as JSON
`

type Options = NonNullable<ParseArgsConfig["options"]>

/**
 * What each command takes besides its path, declared once. `parseArgs` in
 * strict mode refuses anything else, so a mistyped `--rank` or a
 * `--ranked=true` is a bad argument, not the every-game set run and passed,
 * which would read as a pass of the ranked set.
 */
const COMMANDS = {
  run: {
    ranked: { type: "boolean" },
    json: { type: "boolean" },
    only: { type: "string" },
    seeds: { type: "string" },
  },
  scan: {},
} as const satisfies Record<string, Options>

/**
 * A command's arguments: its one path and the options it declares, or null
 * with the reason printed when they are anything else.
 */
function parse<T extends Options>(
  command: string,
  options: T,
  args: readonly string[],
) {
  const parsed = (() => {
    try {
      return parseArgs({
        args: [...args],
        options,
        strict: true,
        allowPositionals: true,
      })
    } catch (error) {
      // parseArgs names the argument: "Unknown option '--rank'".
      console.error(
        `${command}: ${String((error as Error).message)}\n\n${USAGE}`,
      )
      return null
    }
  })()
  if (parsed === null) return null
  const [path, ...extra] = parsed.positionals
  if (path === undefined) {
    console.error(`${command} needs a path`)
    console.log(USAGE)
    return null
  }
  if (extra.length > 0) {
    console.error(
      `${command} takes one path, and was also given ${extra.join(", ")}\n\n${USAGE}`,
    )
    return null
  }
  return { path, values: parsed.values }
}

/** Clears the progress line, which is at most the longest check name long. */
const CLEAR_PROGRESS = `${" ".repeat(CHECK_NAME_WIDTH + 5)}\r`

async function main(argv: readonly string[]): Promise<number> {
  const [command, ...rest] = argv
  if (command === undefined) {
    console.log(USAGE)
    return 0
  }

  if (command === "scan") {
    const args = parse(command, COMMANDS.scan, rest)
    if (args === null) return 2
    const result = scanImportGraph(args.path)
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

  const args = parse(command, COMMANDS.run, rest)
  if (args === null) return 2
  const { only, seeds, json: asJson, ranked } = args.values
  const subject = await loadSubject(args.path)
  let report: Report
  try {
    report = await validate(subject, {
      set: ranked === true ? "ranked" : "every-game",
      ...(only === undefined ? {} : { only: only.split(",") }),
      ...(seeds === undefined ? {} : { seeds: seeds.split(",") }),
      ...(asJson === true
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

  if (asJson === true) {
    console.log(JSON.stringify(report, null, 2))
  } else {
    process.stderr.write(CLEAR_PROGRESS)
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
