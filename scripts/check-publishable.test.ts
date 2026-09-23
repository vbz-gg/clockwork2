import { describe, expect, test } from "bun:test"
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  exportTargets,
  PUBLIC_PACKAGES,
  problemsWith,
  type Shipped,
  unimportableSubpaths,
} from "./check-publishable"

function shipped(over: Partial<Shipped> = {}): Shipped {
  return {
    name: "@clockwork2/engine",
    version: "0.1.0",
    dependencies: {},
    files: ["package.json", "README.md", "dist/index.js", "src/index.ts"],
    imports: { problems: [], skipped: [] },
    ...over,
  }
}

describe("what a tarball would do to a consumer", () => {
  test("a good package has nothing to say about it", () => {
    expect(problemsWith(shipped())).toEqual([])
  })

  test("an unrewritten workspace range is caught", () => {
    // The whole reason this file exists. npm ships the string as written and
    // the published version is then uninstallable by anyone, permanently.
    const problems = problemsWith(
      shipped({ dependencies: { "@clockwork2/engine": "workspace:*" } }),
    )
    expect(problems.join("\n")).toContain("no consumer can install")
  })

  test("a missing readme is caught, because npm drops it quietly", () => {
    const problems = problemsWith(
      shipped({ files: ["package.json", "dist/index.js"] }),
    )
    expect(problems.join("\n")).toContain("no README.md")
  })

  test("packing without a build is caught", () => {
    const problems = problemsWith(
      shipped({ files: ["package.json", "README.md", "src/index.ts"] }),
    )
    expect(problems.join("\n")).toContain("no dist")
  })

  test("a third-party dependency is left alone", () => {
    expect(
      problemsWith(shipped({ dependencies: { typescript: "5.9.3" } })),
    ).toEqual([])
  })

  test("a subpath node cannot import is a problem", () => {
    const problems = problemsWith(
      shipped({
        imports: {
          problems: ['node cannot import "./dmath": ...'],
          skipped: [],
        },
      }),
    )
    expect(problems.join("\n")).toContain("./dmath")
  })

  test("the checker packs what publish.ts publishes", async () => {
    // Two files naming the same directory. When this was six packages they
    // held two lists that could drift apart; now it is one name, and it still
    // has to be the same name or the check measures a package nobody ships.
    const source = await Bun.file(
      new URL("./publish.ts", import.meta.url).pathname,
    ).text()
    for (const pkg of PUBLIC_PACKAGES) {
      expect(source).toContain(`packages/${pkg}`)
    }
  })
})

describe("what plain node makes of the exports map", () => {
  test("every shape of exports entry resolves to its file", () => {
    expect(
      exportTargets({
        ".": { default: "./dist/index.js" },
        "./package.json": "./package.json",
        "./types-only": {},
      }),
    ).toEqual([
      [".", "./dist/index.js"],
      ["./package.json", "./package.json"],
    ])
  })

  test("no exports map is no targets, rather than a throw", () => {
    expect(exportTargets(undefined)).toEqual([])
  })

  /**
   * The defect this whole function exists for. `tsc` emits a relative import
   * exactly as the source wrote it, bun and every bundler resolve an
   * extensionless one, and node does not - so a package builds, typechecks,
   * passes its suite and fails on a consumer's first import.
   */
  test("an extensionless relative import is caught", async () => {
    const dir = await mkdtemp(join(tmpdir(), "cw2-importable-"))
    try {
      await mkdir(join(dir, "dist"), { recursive: true })
      await writeFile(join(dir, "dist", "helper.js"), "export const a = 1\n")
      await writeFile(
        join(dir, "dist", "good.js"),
        'export * from "./helper.js"\n',
      )
      await writeFile(join(dir, "dist", "bad.js"), 'export * from "./helper"\n')
      await writeFile(
        join(dir, "package.json"),
        JSON.stringify({
          name: "probe",
          type: "module",
          exports: {
            "./good": { default: "./dist/good.js" },
            "./bad": { default: "./dist/bad.js" },
            // Data rather than a module: importing JSON needs an import
            // attribute, and what a consumer does with it is their business.
            "./package.json": "./package.json",
          },
        }),
      )

      const report = await unimportableSubpaths(dir)
      expect(report.skipped).toEqual([])
      expect(report.problems.length).toBe(1)
      expect(report.problems[0]).toContain('"./bad"')
      expect(report.problems[0]).toContain("Cannot find module")
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  }, 30_000)

  /**
   * An optional peer that nobody installed here is not a finding about the
   * package. Reporting it as one would fail this check on every machine
   * without pixi, which is every machine.
   */
  test("a missing optional peer is reported as unchecked, not as broken", async () => {
    const dir = await mkdtemp(join(tmpdir(), "cw2-importable-peer-"))
    try {
      await mkdir(join(dir, "dist"), { recursive: true })
      await writeFile(
        join(dir, "dist", "adapter.js"),
        'import "not-a-real-package-91a3"\nexport const a = 1\n',
      )
      await writeFile(
        join(dir, "package.json"),
        JSON.stringify({
          name: "probe",
          type: "module",
          exports: { "./adapter": { default: "./dist/adapter.js" } },
        }),
      )

      const report = await unimportableSubpaths(dir)
      expect(report.problems).toEqual([])
      expect(report.skipped.join("\n")).toContain("not-a-real-package-91a3")
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  }, 30_000)
})
