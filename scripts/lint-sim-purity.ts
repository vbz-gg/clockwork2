/**
 * Scans built output for calls a simulation may not make.
 *
 * This runs on the *built* bundle rather than on source, because a source lint
 * only sees the file in front of it. A banned call arriving through a helper,
 * a transitive import or an aliased global is invisible to it and plain to
 * this. The kernel's runtime shims are the third layer: a scan misses a path
 * it cannot see, and a shim misses a path that never runs.
 *
 * Usage: bun run scripts/lint-sim-purity.ts [dir ...]
 */
import { readdirSync, readFileSync, statSync } from "node:fs"
import { join, relative } from "node:path"

const BANNED: ReadonlyArray<readonly [RegExp, string]> = [
  [
    /\bMath\s*\.\s*(sin|cos|tan|asin|acos|atan|atan2|exp|log|log2|log10|log1p|expm1|pow|cbrt|hypot|sinh|cosh|tanh|asinh|acosh|atanh|random)\b/g,
    "implementation-defined Math function; use @clockwork2/kernel/dmath",
  ],
  [/\*\*(?!\/)/g, "the ** operator is banned; use dmath.ipow or dmath.pow"],
  [/\bDate\s*\.\s*now\b/g, "wall clock"],
  [/\bnew\s+Date\b/g, "wall clock"],
  [/\bperformance\s*\.\s*now\b/g, "wall clock"],
  [/\bsetTimeout\b|\bsetInterval\b/g, "host timer; use the kernel Timer"],
  [/\brequestAnimationFrame\b/g, "host frame callback"],
  [/\bcrypto\s*\./g, "non-deterministic source"],
  [/\bIntl\b|\.toLocaleString\b|\.localeCompare\b/g, "locale-dependent"],
  [/\bWeakRef\b|\bFinalizationRegistry\b/g, "observable garbage collection"],
  [/\bstructuredClone\b|\bqueueMicrotask\b|\bAtomics\b/g, "banned global"],
]

/** Files that are allowed to name a banned API, with the reason. */
const ALLOWED = [
  /\/shims\./, // the shim module names every global it traps
  /\/errors\./, // the error table quotes the API names
  /lint-sim-purity/,
]

/**
 * Blanks comments, string and template literals, and regular expressions,
 * keeping every newline so reported line numbers stay true. Scanning raw text
 * would report the `**` in a JSDoc opener and the word `Date` in a sentence.
 *
 * The one judgement call is telling a regular expression from a division. The
 * usual heuristic applies: a slash after a value (identifier, number, closing
 * bracket) divides, and a slash anywhere else opens a pattern.
 */
export function blankNonCode(source: string): string {
  const out = source.split("")
  const blank = (from: number, to: number) => {
    for (let i = from; i < to && i < out.length; i++) {
      if (out[i] !== "\n") out[i] = " "
    }
  }
  let i = 0
  let lastSignificant = ""
  while (i < source.length) {
    const c = source[i] as string
    const next = source[i + 1]
    if (c === "/" && next === "/") {
      let j = i
      while (j < source.length && source[j] !== "\n") j++
      blank(i, j)
      i = j
      continue
    }
    if (c === "/" && next === "*") {
      let j = i + 2
      while (j < source.length && !(source[j] === "*" && source[j + 1] === "/"))
        j++
      blank(i, Math.min(j + 2, source.length))
      i = j + 2
      continue
    }
    if (c === '"' || c === "'" || c === "`") {
      let j = i + 1
      while (j < source.length) {
        if (source[j] === "\\") {
          j += 2
          continue
        }
        if (source[j] === c) break
        j++
      }
      blank(i + 1, j)
      i = j + 1
      lastSignificant = c
      continue
    }
    if (c === "/" && !/[\w$)\]]/.test(lastSignificant)) {
      let j = i + 1
      let inClass = false
      while (j < source.length && source[j] !== "\n") {
        if (source[j] === "\\") {
          j += 2
          continue
        }
        if (source[j] === "[") inClass = true
        else if (source[j] === "]") inClass = false
        else if (source[j] === "/" && !inClass) break
        j++
      }
      blank(i + 1, j)
      i = j + 1
      lastSignificant = "/"
      continue
    }
    if (!/\s/.test(c)) lastSignificant = c
    i++
  }
  return out.join("")
}

function* walk(dir: string): Generator<string> {
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry)
    if (statSync(path).isDirectory()) {
      if (entry === "node_modules") continue
      yield* walk(path)
    } else if (path.endsWith(".js") || path.endsWith(".mjs")) {
      yield path
    }
  }
}

const roots = process.argv.slice(2)
const targets = roots.length > 0 ? roots : ["packages/kernel/dist"]
let failures = 0
let scanned = 0

for (const root of targets) {
  let stat: ReturnType<typeof statSync>
  try {
    stat = statSync(root)
  } catch {
    console.error(`not found: ${root} (did you run "bun run build"?)`)
    process.exit(3)
  }
  if (!stat.isDirectory()) continue

  for (const file of walk(root)) {
    if (ALLOWED.some((re) => re.test(file))) continue
    scanned++
    const raw = readFileSync(file, "utf8")
    const source = blankNonCode(raw)
    const lines = raw.split("\n")
    for (const [pattern, why] of BANNED) {
      pattern.lastIndex = 0
      let match = pattern.exec(source)
      while (match !== null) {
        const line = source.slice(0, match.index).split("\n").length
        const text = lines[line - 1]?.trim() ?? ""
        console.error(
          `${relative(process.cwd(), file)}:${line}  ${match[0]}  ${why}\n    ${text}`,
        )
        failures++
        match = pattern.exec(source)
      }
    }
  }
}

if (failures > 0) {
  console.error(`\n${failures} banned call(s) in ${scanned} built file(s)`)
  process.exit(1)
}
console.log(`simulation purity: clean (${scanned} built files)`)
