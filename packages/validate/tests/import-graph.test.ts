/**
 * The static scan, one source shape at a time.
 *
 * Two failure modes matter here and they pull in opposite directions. A scan
 * that misses a banned call passes a bundle that cannot be replayed. A scan
 * that reports a local variable called `document` refuses a bundle that was
 * fine, and a submitter has no way to argue with it. So the shadowing cases
 * are tested as carefully as the banned ones.
 *
 * Sources are written to a temp directory: they contain the calls the
 * repository's own lint forbids, and several of them do not type-check on
 * purpose.
 */

import { afterEach, describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { scanImportGraph } from "../src/scan/import-graph"

const dirs: string[] = []
afterEach(() => {
  while (dirs.length > 0) {
    rmSync(dirs.pop() as string, { recursive: true, force: true })
  }
})

/** Writes a scratch bundle and scans its entry. */
function scan(files: Record<string, string>, entry = "index.ts") {
  const dir = mkdtempSync(join(tmpdir(), "cw2-scratch-scan-"))
  dirs.push(dir)
  for (const [path, contents] of Object.entries(files)) {
    const full = join(dir, path)
    mkdirSync(join(full, ".."), { recursive: true })
    writeFileSync(full, contents)
  }
  return { dir, result: scanImportGraph(join(dir, entry)) }
}

function names(files: Record<string, string>, entry?: string): string[] {
  return scan(files, entry).result.findings.map((f) => f.name)
}

describe("banned names", () => {
  test("a global", () => {
    expect(names({ "index.ts": "export const x = localStorage\n" })).toEqual([
      "localStorage",
    ])
  })

  test("a member, reported once rather than twice", () => {
    // `Date` is a banned global and `Date.now` a banned member. Reporting both
    // on one site would make a single call look like two problems.
    expect(names({ "index.ts": "export const t = Date.now()\n" })).toEqual([
      "Date.now",
    ])
  })

  /**
   * A property is banned wherever the object came from, because there is no
   * way to know statically what `value` is. `toLocaleString` is the one that
   * bites: it reads a number differently depending on the machine's locale.
   */
  test("a property, whatever it was reached through", () => {
    expect(
      names({ "index.ts": "export const s = (42).toLocaleString()\n" }),
    ).toEqual(["toLocaleString"])
  })

  test("a renderer package in an import", () => {
    const found = scan({
      "index.ts": 'import { Scene } from "three"\nexport default Scene\n',
    }).result.findings
    expect(found.map((f) => f.name)).toEqual(["three"])
    expect(found[0]?.why).toContain("renderer or physics package")
  })

  test("the ** operator", () => {
    expect(names({ "index.ts": "export const x = 2 ** 8\n" })).toEqual(["**"])
    expect(names({ "index.ts": "export let y = 2\ny **= 8\n" })).toEqual(["**"])
  })
})

describe("asynchronous work", () => {
  test("await", () => {
    expect(
      names({
        "index.ts": "export const f = async () => await Promise.resolve(1)\n",
      }),
    ).toEqual(["async", "await"])
  })

  test("for await, which has no await expression of its own", () => {
    const found = names({
      "index.ts": `export async function f(xs: AsyncIterable<number>) {
  for await (const x of xs) void x
}
`,
    })
    expect(found).toContain("for await")
  })

  test("a plain for-of is not reported", () => {
    // The awaitModifier is the whole difference; a scan that keyed on
    // ForOfStatement alone would refuse every loop in every game.
    expect(
      names({
        "index.ts":
          "export const f = (xs: number[]) => { for (const x of xs) void x }\n",
      }),
    ).toEqual([])
  })
})

describe("a name the game declared is the game's own", () => {
  /**
   * These are the false positives that would make the scan unusable. A game
   * may have a local called `document`, a destructured `crypto`, or a namespace
   * import named `Intl`, and none of them is the global.
   */
  test("a destructured binding shadows a banned global", () => {
    expect(
      names({
        "index.ts":
          "const { crypto } = { crypto: 1 }\nexport const x = crypto\n",
      }),
    ).toEqual([])
  })

  test("a nested destructured binding too", () => {
    expect(
      names({
        "index.ts":
          "const { inner: { document } } = { inner: { document: 1 } }\nexport const x = document\n",
      }),
    ).toEqual([])
  })

  test("a namespace import shadows one", () => {
    expect(
      names({
        "index.ts":
          'import * as Intl from "./helpers"\nexport const x = Intl\n',
        "helpers.ts": "export const a = 1\n",
      }),
    ).toEqual([])
  })

  test("a function parameter shadows one", () => {
    expect(
      names({
        "index.ts": "export const f = (navigator: number) => navigator\n",
      }),
    ).toEqual([])
  })

  test("a banned name used as a property key is not a read of the global", () => {
    expect(
      names({
        "index.ts":
          "export const o = { crypto: 1 }\nexport const p = o.crypto\n",
      }),
    ).toEqual([])
  })
})

describe("following imports", () => {
  test("a banned call one file away is still found", () => {
    const found = names({
      "index.ts": 'import { roll } from "./dice"\nexport default roll\n',
      "dice.ts": "export const roll = () => Math.random()\n",
    })
    expect(found).toEqual(["Math.random"])
  })

  test("a .js entry is parsed as JavaScript", () => {
    // Parsing it as TypeScript would be wrong about several syntaxes, and a
    // parse that goes wrong reports nothing at all.
    expect(
      names({ "index.js": "export const x = Math.random()\n" }, "index.js"),
    ).toEqual(["Math.random"])
  })

  test("a dynamic import with a literal path is followed", () => {
    const found = names({
      "index.ts": 'export const load = () => import("./later")\n',
      "later.ts": "export const x = Math.random()\n",
    })
    expect(found).toEqual(["Math.random"])
  })

  /**
   * A computed specifier is where a bundle could hide anything, so the scan
   * says it could not follow rather than reporting nothing and moving on.
   */
  test("a dynamic import it cannot follow is reported", () => {
    const found = scan({
      // Concatenated rather than interpolated, so the specifier is computed
      // without this file carrying a template placeholder of its own.
      "index.ts": 'export const load = (name: string) => import("./" + name)\n',
    }).result.findings
    expect(found.map((f) => f.name)).toEqual(["import()"])
    expect(found[0]?.why).toContain("cannot follow")
  })

  test("an import that does not resolve is listed, not skipped", () => {
    const { result } = scan({
      "index.ts": 'import "./nowhere"\nexport default 1\n',
    })
    expect(result.unresolved).toEqual(["./nowhere"])
  })

  test("a node builtin is neither followed nor reported", () => {
    const { result } = scan({
      "index.ts": 'import { join } from "node:path"\nexport default join\n',
    })
    expect(result.unresolved).toEqual([])
    expect(result.findings).toEqual([])
  })

  /**
   * The kernel is trusted rather than scanned: it is full of the very calls a
   * game may not make, because it is what makes them unnecessary.
   */
  test("a trusted package is recorded as trusted and not walked", () => {
    const { result } = scan({
      "index.ts":
        'import { Prng } from "@clockwork2/kernel"\nexport default Prng\n',
    })
    expect(result.trusted).toEqual(["@clockwork2/kernel"])
    expect(result.files.every((f) => !f.includes("packages/kernel"))).toBe(true)
  })

  test("an entry that cannot be read is unresolved rather than a throw", () => {
    const result = scanImportGraph(
      join(tmpdir(), "cw2-scratch-no-such-entry.ts"),
    )
    expect(result.files).toEqual([])
    expect(result.unresolved.length).toBe(1)
  })

  test("the file budget stops a graph that would not end", () => {
    // Two files importing each other is the small version of a graph that
    // outlasts the validator's patience.
    const { result } = scan(
      {
        "index.ts": 'import "./b"\nexport default 1\n',
        "b.ts": 'import "./index"\nexport default 2\n',
      },
      "index.ts",
    )
    expect(result.files.length).toBe(2)
  })
})

describe("where a finding points", () => {
  test("carries the file, line and column of the call", () => {
    const { dir, result } = scan({
      "index.ts": "export const a = 1\nexport const b = Math.random()\n",
    })
    const finding = result.findings[0]
    expect(finding?.file).toBe(join(dir, "index.ts"))
    expect(finding?.line).toBe(2)
    expect(finding?.column).toBeGreaterThan(0)
  })
})
