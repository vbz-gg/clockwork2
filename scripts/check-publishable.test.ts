import { describe, expect, test } from "bun:test"
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import {
  type CommittedFile,
  committedGuide,
  exportTargets,
  GUIDE,
  guideDifferences,
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
    guide: [],
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

  test("a guide that differs from the committed one is a problem", () => {
    const problems = problemsWith(
      shipped({
        guide: [
          `${GUIDE}/SKILL.md in the tarball differs from the committed file`,
        ],
      }),
    )
    expect(problems.join("\n")).toContain(`${GUIDE}/SKILL.md`)
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
   * A data target is not imported, and it must still exist. The exports map
   * named `./manifest.schema.json` from 0.1.0 to 0.7.3, a file the build never
   * made, and a consumer asking for it got ERR_MODULE_NOT_FOUND.
   */
  test("an exports entry for a file the tarball lacks is caught", async () => {
    const dir = await mkdtemp(join(tmpdir(), "cw2-importable-data-"))
    try {
      await writeFile(join(dir, "present.json"), "{}\n")
      await writeFile(
        join(dir, "package.json"),
        JSON.stringify({
          name: "probe",
          type: "module",
          exports: {
            "./present.json": "./present.json",
            "./schema.json": "./dist/schema.json",
            "./package.json": "./package.json",
          },
        }),
      )
      const report = await unimportableSubpaths(dir)
      expect(report.problems).toEqual([
        "./schema.json points at ./dist/schema.json, which the tarball does not carry",
      ])
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

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

describe("the guide the tarball carries", () => {
  type Tree = Record<string, { text: string; executable?: boolean }>

  /** Writes a tree of files under `root`, at paths inside the package. */
  async function write(root: string, tree: Tree): Promise<string[]> {
    for (const [path, file] of Object.entries(tree)) {
      await mkdir(dirname(join(root, path)), { recursive: true })
      await writeFile(join(root, path), file.text)
      await chmod(join(root, path), file.executable === true ? 0o755 : 0o644)
    }
    return Object.keys(tree).sort()
  }

  const GOOD: Tree = {
    [`${GUIDE}/SKILL.md`]: { text: "---\nname: clockwork2\n---\n" },
    [`${GUIDE}/scripts/validate.sh`]: {
      text: "#!/usr/bin/env bash\n",
      executable: true,
    },
  }

  /** What git would hold for a tree, without a repository to hold it. */
  function asCommitted(tree: Tree): Map<string, CommittedFile> {
    return new Map(
      Object.entries(tree).map(([path, file]) => [
        path,
        {
          bytes: new TextEncoder().encode(file.text),
          executable: file.executable === true,
        },
      ]),
    )
  }

  /** Unpacks `inTarball` to a directory and compares it with `committed`. */
  async function compare(
    inTarball: Tree,
    committed: Tree = GOOD,
  ): Promise<string[]> {
    const dir = await mkdtemp(join(tmpdir(), "cw2-guide-"))
    try {
      const shipped = await write(dir, {
        "package.json": { text: "{}" },
        ...inTarball,
      })
      return guideDifferences(dir, shipped, asCommitted(committed))
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  }

  test("the committed guide, packed whole, has nothing to say", async () => {
    expect(await compare(GOOD)).toEqual([])
  })

  test("a byte that differs is named, as an edit nobody committed is", async () => {
    // npm packs the working tree, so an uncommitted edit is what ships.
    const problems = await compare({
      ...GOOD,
      [`${GUIDE}/SKILL.md`]: { text: "---\nname: clockwork3\n---\n" },
    })
    expect(problems).toEqual([
      `${GUIDE}/SKILL.md in the tarball differs from the committed file`,
    ])
  })

  test("a committed file the tarball dropped is named", async () => {
    // npm drops a file an ignore rule matches, and says nothing about it.
    const problems = await compare({
      [`${GUIDE}/SKILL.md`]: { text: "---\nname: clockwork2\n---\n" },
    })
    expect(problems).toEqual([
      `${GUIDE}/scripts/validate.sh is committed and the tarball does not carry it`,
    ])
  })

  test("an untracked file is named, because npm packs the disk", async () => {
    // A scratch note left in the guide's folder ships: measured with a
    // `notes.txt` beside SKILL.md, which `npm pack` put in the tarball.
    const problems = await compare({
      ...GOOD,
      [`${GUIDE}/notes.txt`]: { text: "scratch" },
    })
    expect(problems).toEqual([
      `${GUIDE}/notes.txt is in the tarball and is not committed`,
    ])
  })

  test("the guide's tests shipping beside it are named", async () => {
    const problems = await compare({
      ...GOOD,
      "skill/tests/skill.test.ts": { text: "test()" },
    })
    expect(problems).toEqual([
      `skill/tests/skill.test.ts ships, and only ${GUIDE}/ belongs under skill/`,
    ])
  })

  test("a script that lost its execute bit is named", async () => {
    // The guide's commands run its scripts directly, so a copy that is no
    // longer executable is a command that fails on the author's machine.
    const problems = await compare({
      ...GOOD,
      [`${GUIDE}/scripts/validate.sh`]: { text: "#!/usr/bin/env bash\n" },
    })
    expect(problems).toEqual([
      `${GUIDE}/scripts/validate.sh is executable when committed and not in the tarball`,
    ])
  })

  test("no committed guide at all is a problem, not a pass", async () => {
    // A listing that came back empty would otherwise compare nothing against
    // nothing and agree.
    const problems = await compare({}, {})
    expect(problems).toEqual([
      `no committed files under ${GUIDE}/ to compare with`,
    ])
  })

  test("the engine's committed guide is read as git holds it", async () => {
    // The listing is what the comparison trusts for "committed": paths inside
    // the package, under the guide and not its tests, with git's bytes and
    // git's mode for each.
    const engine = join(import.meta.dir, "../packages/engine")
    const committed = await committedGuide(engine)
    const paths = [...committed.keys()]
    expect(paths).toContain(`${GUIDE}/SKILL.md`)
    expect(paths.every((path) => path.startsWith(`${GUIDE}/`))).toBe(true)
    expect(committed.get(`${GUIDE}/scripts/validate.sh`)?.executable).toBe(true)
    expect(committed.get(`${GUIDE}/SKILL.md`)?.executable).toBe(false)
    const skill = committed.get(`${GUIDE}/SKILL.md`)?.bytes ?? new Uint8Array()
    expect(new TextDecoder().decode(skill)).toStartWith("---\nname: ")
  })
})
