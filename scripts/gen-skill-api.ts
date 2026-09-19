#!/usr/bin/env bun
/**
 * Generates the agent skill's API reference from the built type declarations.
 *
 * It is generated for one reason: a hand-written API reference is a second
 * source of truth, and the moment the two disagree the agent follows the one
 * that is wrong. Here the declarations are the source and this file is a
 * projection of them, so a renamed export changes the reference in the same
 * commit or `skill/tests/skill.test.ts` fails.
 *
 *   bun run scripts/gen-skill-api.ts          write the reference
 *   bun run scripts/gen-skill-api.ts --check  fail if it is out of date
 *
 * Reads `dist`, not `src`: the declarations are what a consumer's editor sees,
 * and they are already stripped of implementation. Run `bun run build` first.
 */

import { existsSync, readFileSync, writeFileSync } from "node:fs"
import { join, relative } from "node:path"
import ts from "typescript"

const ROOT = new URL("..", import.meta.url).pathname
const OUT = join(ROOT, "skill/platform-game/references/kernel-api.md")

/** Entry points, in the order an agent meets them. */
const ENTRIES: ReadonlyArray<{
  readonly specifier: string
  readonly file: string
  readonly blurb: string
}> = [
  {
    specifier: "@clockwork2/kernel",
    file: "packages/kernel/dist/index.d.ts",
    blurb: "The contract, the loop, and everything a simulation may call.",
  },
  {
    specifier: "@clockwork2/kernel/dmath",
    file: "packages/kernel/dist/dmath/index.d.ts",
    blurb:
      "Deterministic transcendentals. Every one of these replaces a `Math` function that ECMAScript leaves implementation-defined.",
  },
  {
    specifier: "@clockwork2/kernel/testing",
    file: "packages/kernel/dist/testing/index.d.ts",
    blurb: "Input logs and comparison helpers, shared with the validator.",
  },
  {
    specifier: "@clockwork2/host-bridge",
    file: "packages/host-bridge/dist/index.d.ts",
    blurb:
      "Running a game in a page: the accumulator loop, input capture and the frame protocol. Not reachable from a simulation.",
  },
  {
    specifier: "@clockwork2/validate",
    file: "packages/validate/dist/index.d.ts",
    blurb: "The conformance suite, as a library. The CLI wraps this.",
  },
]

/** The first paragraph of a doc comment, as one line. */
function summary(symbol: ts.Symbol, checker: ts.TypeChecker): string {
  const parts = symbol.getDocumentationComment(checker)
  const text = ts.displayPartsToString(parts).trim()
  if (text === "") return ""
  const paragraph = text.split(/\n\s*\n/)[0] ?? ""
  return paragraph.replace(/\s*\n\s*/g, " ").trim()
}

function declarationText(symbol: ts.Symbol): string {
  const declaration = symbol.getDeclarations()?.[0]
  if (declaration === undefined) return ""
  const source = declaration.getSourceFile().text
  // The declaration's own text, minus the leading doc comment, which is
  // printed separately as prose.
  const text = source.slice(declaration.getStart(), declaration.getEnd()).trim()
  // A private field is in the declarations because the emitter has to reserve
  // the name, not because a caller may touch it. Listing them would tell an
  // agent that `accumulator.carried` exists.
  return text
    .split("\n")
    .filter((line) => !/^\s*(private|protected)\s/.test(line))
    .join("\n")
}

function kindOf(symbol: ts.Symbol): string {
  const flags = symbol.getFlags()
  if (flags & ts.SymbolFlags.Class) return "class"
  if (flags & ts.SymbolFlags.Interface) return "interface"
  if (flags & ts.SymbolFlags.TypeAlias) return "type"
  if (flags & ts.SymbolFlags.Enum) return "enum"
  if (flags & ts.SymbolFlags.Function) return "function"
  if (flags & ts.SymbolFlags.Module) return "namespace"
  return "const"
}

/** class, then function, then type, so the useful things come first. */
const ORDER = [
  "class",
  "function",
  "const",
  "interface",
  "type",
  "enum",
  "namespace",
]

function render(
  entry: (typeof ENTRIES)[number],
  checker: ts.TypeChecker,
  moduleSymbol: ts.Symbol,
): string {
  const lines: string[] = [`## \`${entry.specifier}\``, "", entry.blurb, ""]
  const exported = checker
    .getExportsOfModule(moduleSymbol)
    .map((symbol) =>
      symbol.flags & ts.SymbolFlags.Alias
        ? checker.getAliasedSymbol(symbol)
        : symbol,
    )

  const sorted = [...exported].sort((a, b) => {
    const byKind = ORDER.indexOf(kindOf(a)) - ORDER.indexOf(kindOf(b))
    return byKind !== 0 ? byKind : a.getName().localeCompare(b.getName())
  })

  for (const symbol of sorted) {
    const text = declarationText(symbol)
    if (text === "") continue
    const note = summary(symbol, checker)
    lines.push(`### ${symbol.getName()}`, "")
    if (note !== "") lines.push(note, "")
    lines.push("```ts", text, "```", "")
  }
  return lines.join("\n")
}

function generate(): string {
  const files = ENTRIES.map((entry) => join(ROOT, entry.file))
  const missing = files.filter((file) => !existsSync(file))
  if (missing.length > 0) {
    throw new Error(
      `no declarations at ${missing.map((f) => relative(ROOT, f)).join(", ")}; run "bun run build" first`,
    )
  }

  const program = ts.createProgram(files, {
    target: ts.ScriptTarget.ESNext,
    module: ts.ModuleKind.ESNext,
    moduleResolution: ts.ModuleResolutionKind.Bundler,
    skipLibCheck: true,
    noEmit: true,
  })
  const checker = program.getTypeChecker()

  const body: string[] = []
  for (const entry of ENTRIES) {
    const source = program.getSourceFile(join(ROOT, entry.file))
    if (source === undefined) throw new Error(`could not read ${entry.file}`)
    const moduleSymbol = checker.getSymbolAtLocation(source)
    if (moduleSymbol === undefined) {
      throw new Error(`${entry.file} exports nothing`)
    }
    body.push(render(entry, checker, moduleSymbol))
  }

  return [
    "# Kernel API",
    "",
    "**Generated from the built type declarations. Do not edit.**",
    "Regenerate with `bun run scripts/gen-skill-api.ts`; `skill/tests/skill.test.ts`",
    "fails when this file and the declarations disagree.",
    "",
    "Anything not listed here is not part of the contract. Where this reference",
    "and `@clockwork2/validate` disagree, the validator is right.",
    "",
    body.join("\n"),
  ].join("\n")
}

const generated = generate()

if (process.argv.includes("--check")) {
  const current = existsSync(OUT) ? readFileSync(OUT, "utf8") : ""
  if (current !== generated) {
    console.error(
      `${relative(ROOT, OUT)} is out of date; run "bun run scripts/gen-skill-api.ts"`,
    )
    process.exit(1)
  }
  console.log(`${relative(ROOT, OUT)} is up to date`)
} else {
  writeFileSync(OUT, generated)
  console.log(
    `${relative(ROOT, OUT)}  ${generated.split("\n").length} lines from ${ENTRIES.length} entry points`,
  )
}
