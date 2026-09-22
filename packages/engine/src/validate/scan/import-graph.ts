/**
 * The static scan: what a simulation names, across its whole import graph.
 *
 * TypeScript's own parser does the reading, rather than a regular expression
 * or a transpile-then-parse pass. Two reasons. It gives exact line and column
 * numbers in the source a developer actually has, where a transpiled form has
 * moved every line. And it reads `.ts` and `.js` the same way, so a scan of a
 * source tree and a scan of a built bundle report the same things.
 *
 * The scan is necessary and not sufficient, which is why the kernel also
 * installs runtime traps. A scan cannot see an aliased global, a property
 * reached through a computed key, `new Image().src`, or a dynamic import
 * resolved at run time. A trap cannot see a path that never runs. Both are
 * cheap; neither is optional.
 */

import { readFileSync } from "node:fs"
import { dirname } from "node:path"
import ts from "typescript"
import {
  BANNED_GLOBALS,
  BANNED_IMPORTS,
  BANNED_MEMBERS,
  BANNED_PROPERTIES,
} from "./banned"

export type ScanFindingKind =
  | "global"
  | "member"
  | "property"
  | "import"
  | "exponent"
  | "async"

export type ScanFinding = {
  readonly kind: ScanFindingKind
  readonly name: string
  readonly why: string
  readonly file: string
  readonly line: number
  readonly column: number
}

export type ScanResult = {
  /** Every file the scan read, in the order it reached them. */
  readonly files: readonly string[]
  /** Specifiers it could not resolve, which are reported rather than ignored. */
  readonly unresolved: readonly string[]
  /** Packages excluded as platform-provided. */
  readonly trusted: readonly string[]
  readonly findings: readonly ScanFinding[]
}

export interface ScanOptions {
  /**
   * Import specifiers whose files are not scanned, because the platform ships
   * them and audits them separately. The kernel names `Date` and
   * `performance` in its own trap table, so scanning it would report the
   * mechanism as a violation.
   */
  readonly trustedPrefixes?: readonly string[]
  /** A cap, so a cycle or a huge graph cannot run away. */
  readonly maxFiles?: number
}

const DEFAULT_TRUSTED = ["@clockwork2/"]
const DEFAULT_MAX_FILES = 2000

function isBuiltinModule(specifier: string): boolean {
  return specifier.startsWith("node:") || specifier.startsWith("bun:")
}

/** Names bound somewhere in this file, which therefore are not the global. */
function collectDeclaredNames(source: ts.SourceFile): ReadonlySet<string> {
  const declared = new Set<string>()
  const addBinding = (name: ts.BindingName): void => {
    if (ts.isIdentifier(name)) {
      declared.add(name.text)
      return
    }
    for (const element of name.elements) {
      if (ts.isBindingElement(element)) addBinding(element.name)
    }
  }
  const visit = (node: ts.Node): void => {
    if (ts.isVariableDeclaration(node)) addBinding(node.name)
    else if (ts.isParameter(node)) addBinding(node.name)
    else if (
      (ts.isFunctionDeclaration(node) || ts.isClassDeclaration(node)) &&
      node.name !== undefined
    ) {
      declared.add(node.name.text)
    } else if (ts.isImportSpecifier(node) || ts.isImportClause(node)) {
      const name = ts.isImportClause(node) ? node.name : node.name
      if (name !== undefined && ts.isIdentifier(name)) declared.add(name.text)
    } else if (ts.isNamespaceImport(node)) {
      declared.add(node.name.text)
    }
    ts.forEachChild(node, visit)
  }
  ts.forEachChild(source, visit)
  return declared
}

function memberPath(node: ts.PropertyAccessExpression): string | null {
  const parts: string[] = [node.name.text]
  let current: ts.Expression = node.expression
  while (ts.isPropertyAccessExpression(current)) {
    parts.unshift(current.name.text)
    current = current.expression
  }
  if (!ts.isIdentifier(current)) return null
  parts.unshift(current.text)
  return parts.join(".")
}

function scanFile(
  file: string,
  source: string,
  findings: ScanFinding[],
  imports: string[],
): void {
  const parsed = ts.createSourceFile(
    file,
    source,
    ts.ScriptTarget.ESNext,
    true,
    file.endsWith(".ts") || file.endsWith(".tsx")
      ? ts.ScriptKind.TS
      : ts.ScriptKind.JS,
  )
  const declared = collectDeclaredNames(parsed)

  const report = (
    node: ts.Node,
    kind: ScanFindingKind,
    name: string,
    why: string,
  ): void => {
    const { line, character } = parsed.getLineAndCharacterOfPosition(
      node.getStart(parsed),
    )
    findings.push({
      kind,
      name,
      why,
      file,
      line: line + 1,
      column: character + 1,
    })
  }

  const visit = (node: ts.Node): void => {
    if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) {
      const specifier = node.moduleSpecifier
      if (specifier !== undefined && ts.isStringLiteral(specifier)) {
        imports.push(specifier.text)
        for (const banned of BANNED_IMPORTS) {
          if (specifier.text === banned || specifier.text.startsWith(banned)) {
            report(
              node,
              "import",
              specifier.text,
              "a renderer or physics package; the simulation must not import one",
            )
          }
        }
      }
    } else if (
      ts.isCallExpression(node) &&
      node.expression.kind === ts.SyntaxKind.ImportKeyword
    ) {
      const argument = node.arguments[0]
      if (argument !== undefined && ts.isStringLiteral(argument)) {
        imports.push(argument.text)
      } else {
        report(
          node,
          "import",
          "import()",
          "a dynamic import the scan cannot follow",
        )
      }
    } else if (ts.isPropertyAccessExpression(node)) {
      const path = memberPath(node)
      if (path !== null) {
        const why = BANNED_MEMBERS.get(path)
        if (why !== undefined && !declared.has(path.split(".")[0] as string)) {
          report(node, "member", path, why)
        }
      }
      const propertyWhy = BANNED_PROPERTIES.get(node.name.text)
      if (propertyWhy !== undefined) {
        report(node, "property", node.name.text, propertyWhy)
      }
    } else if (ts.isIdentifier(node)) {
      const why = BANNED_GLOBALS.get(node.text)
      if (why !== undefined && !declared.has(node.text)) {
        const parent = node.parent as ts.Node | undefined
        const isMemberName =
          parent !== undefined &&
          ts.isPropertyAccessExpression(parent) &&
          parent.name === node
        const isPropertyName =
          parent !== undefined &&
          (ts.isPropertyAssignment(parent) || ts.isPropertySignature(parent)) &&
          parent.name === node
        // `Date.now` is already reported as a member, so reporting the `Date`
        // in front of it as well would put two findings on one site.
        const coveredByMember =
          parent !== undefined &&
          ts.isPropertyAccessExpression(parent) &&
          parent.expression === node &&
          BANNED_MEMBERS.has(`${node.text}.${parent.name.text}`)
        if (!isMemberName && !isPropertyName && !coveredByMember) {
          report(node, "global", node.text, why)
        }
      }
    } else if (
      ts.isBinaryExpression(node) &&
      (node.operatorToken.kind === ts.SyntaxKind.AsteriskAsteriskToken ||
        node.operatorToken.kind === ts.SyntaxKind.AsteriskAsteriskEqualsToken)
    ) {
      report(
        node,
        "exponent",
        "**",
        "not specified; use dmath.ipow or dmath.pow",
      )
    } else if (ts.isAwaitExpression(node)) {
      report(node, "async", "await", "asynchronous work; tick() is synchronous")
    } else if (ts.isForOfStatement(node) && node.awaitModifier !== undefined) {
      report(
        node,
        "async",
        "for await",
        "asynchronous work; tick() is synchronous",
      )
    }

    const modifiers = ts.canHaveModifiers(node)
      ? ts.getModifiers(node)
      : undefined
    if (
      modifiers?.some((m) => m.kind === ts.SyntaxKind.AsyncKeyword) === true
    ) {
      report(node, "async", "async", "asynchronous work; tick() is synchronous")
    }

    ts.forEachChild(node, visit)
  }

  ts.forEachChild(parsed, visit)
}

/** Reads the entry and everything it imports, and reports what it finds. */
export function scanImportGraph(
  entry: string,
  options: ScanOptions = {},
): ScanResult {
  const trustedPrefixes = options.trustedPrefixes ?? DEFAULT_TRUSTED
  const maxFiles = options.maxFiles ?? DEFAULT_MAX_FILES

  const seen = new Set<string>()
  const files: string[] = []
  const unresolved: string[] = []
  const trusted = new Set<string>()
  const findings: ScanFinding[] = []

  const queue: string[] = [entry]
  while (queue.length > 0 && files.length < maxFiles) {
    const file = queue.shift() as string
    if (seen.has(file)) continue
    seen.add(file)

    let source: string
    try {
      source = readFileSync(file, "utf8")
    } catch {
      unresolved.push(file)
      continue
    }
    files.push(file)

    const imports: string[] = []
    scanFile(file, source, findings, imports)

    for (const specifier of imports) {
      if (isBuiltinModule(specifier)) continue
      if (trustedPrefixes.some((prefix) => specifier.startsWith(prefix))) {
        trusted.add(specifier)
        continue
      }
      try {
        const resolved = Bun.resolveSync(specifier, dirname(file))
        if (!seen.has(resolved)) queue.push(resolved)
      } catch {
        unresolved.push(specifier)
      }
    }
  }

  return { files, unresolved, trusted: [...trusted], findings }
}
