/**
 * The agent guide, checked by machine.
 *
 * The guide is an Agent Skill: prose an agent follows literally, which makes
 * stale prose worse than none, because the agent does exactly what the
 * out-of-date sentence says. So every claim in it that *can* be checked is
 * checked here - the API reference against the declarations it was generated
 * from, the error-code sections against the kernel's table, the templates
 * against the conformance suite the guide tells the reader to run.
 *
 * The guide ships inside the engine package, at `skill/clockwork2/`, and these
 * tests sit beside it rather than in it, so the tarball carries the guide and
 * not its tests. `scripts/check-publishable.ts` compares the two copies.
 *
 * What none of this can check is whether the advice is any good. That is why
 * SKILL.md's first line says the script is right where the two disagree.
 */

import { describe, expect, test } from "bun:test"
import { spawnSync } from "node:child_process"
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { basename, join } from "node:path"
import { ERROR_CODES } from "@clockwork2/engine"
import { loadSubject, validate } from "@clockwork2/engine/validate"

/** `packages/engine/skill`, which holds the guide and these tests. */
const ROOT = join(import.meta.dir, "..")
const ENGINE = join(ROOT, "..")
const REPOSITORY = join(ENGINE, "../..")
const SKILL = join(ROOT, "clockwork2")
const TEMPLATES = join(SKILL, "assets/templates")

function read(path: string): string {
  return readFileSync(join(SKILL, path), "utf8")
}

/** Every Markdown file the guide ships, as a path inside the guide. */
function prose(): string[] {
  return [...new Bun.Glob("**/*.md").scanSync(SKILL)].sort()
}

/** The lines of a Markdown file that sit inside a fenced code block. */
function fencedLines(markdown: string): string[] {
  const lines: string[] = []
  let inside = false
  for (const line of markdown.split("\n")) {
    if (/^\s*```/.test(line)) inside = !inside
    else if (inside) lines.push(line)
  }
  return lines
}

describe("SKILL.md", () => {
  const source = read("SKILL.md")
  const frontmatter = source.split("---")[1] ?? ""

  test("its name matches its directory", () => {
    const name = /^name: (.+)$/m.exec(frontmatter)?.[1]
    expect(name).toBe(basename(SKILL))
    expect(name).toBe("clockwork2")
    expect(name).toMatch(/^[a-z0-9-]{1,64}$/)
  })

  test("the package ships it from the directory it names", () => {
    // A game author's tools install the guide out of the engine package, so
    // the package's `files` has to name the guide and nothing beside it.
    const { files } = JSON.parse(
      readFileSync(join(ENGINE, "package.json"), "utf8"),
    ) as { files: readonly string[] }
    const shipped = files.filter((entry) => entry.startsWith("skill"))
    expect(shipped).toEqual([`skill/${basename(SKILL)}`])
  })

  test("its description is inside the published limit and carries no tags", () => {
    const description = /^description: (.+)$/m.exec(frontmatter)?.[1] ?? ""
    expect(description.length).toBeGreaterThan(40)
    expect(description.length).toBeLessThanOrEqual(1024)
    expect(description).not.toMatch(/<[a-zA-Z/]/)
  })

  test("its body is short enough to be read", () => {
    // A skill is loaded into a context window, so length is a cost paid on
    // every use. The published guidance is 500 lines.
    expect(source.split("\n").length).toBeLessThanOrEqual(500)
  })

  test("it says the script wins where the prose disagrees", () => {
    expect(source).toContain(
      "**Where this file and `scripts/validate.sh` disagree, the script is right.**",
    )
  })

  test("it says its validate script is the engine's checks, not a platform's", () => {
    // A platform built on the engine may run checks of its own beside the
    // engine's, so a guide that called the script what the platform runs
    // would tell an author a local pass is a listing.
    expect(source).toContain(
      "the engine's eleven checks; a platform may run more",
    )
  })

  test("it says its scaffold is for a game on the engine alone", () => {
    // A game built with the vbz kit starts from that kit's scaffold. Copying
    // this guide's templates into one would lay a second game over it.
    expect(source).toContain("are not copied into a vbz game")
  })

  test("every file it points at exists", () => {
    // Prose names a file as `scripts/x.ts`; a command runs it as
    // `<guide>/scripts/x.ts`. Both have to name something the guide ships.
    const referenced = [
      ...source.matchAll(
        /(?:`|<guide>\/)((?:references|scripts)\/[\w.-]+\.\w+)/g,
      ),
    ].map((match) => match[1] as string)
    expect(referenced.length).toBeGreaterThan(8)
    expect(referenced).toContain("scripts/validate.sh")
    for (const path of new Set(referenced)) {
      expect(existsSync(join(SKILL, path)), path).toBe(true)
    }
  })

  test("every reference it ships is pointed at", () => {
    // The other direction: a reference nobody links to is a file the agent
    // never opens.
    const listed = new Set(
      [...source.matchAll(/`(references\/[\w.-]+)`/g)].map(
        (match) => match[1] as string,
      ),
    )
    const shipped = [
      ...new Bun.Glob("*.md").scanSync(join(SKILL, "references")),
    ]
    for (const file of shipped) {
      expect(listed.has(`references/${file}`), file).toBe(true)
    }
  })

  test("every command runs a script by the guide's path, from the game's root", () => {
    // The guide is installed somewhere other than the game - inside the
    // engine package in node_modules, or wherever an agent's tools put it -
    // and every command runs from the game's own root, so `bunx` and the
    // scripts find the engine the game installed. A bare `scripts/validate.sh`
    // run from there names the game's own scripts folder, not this one.
    // A name with arguments after it, in a sentence, is a command too.
    const offenders: string[] = []
    let commands = 0
    for (const file of prose()) {
      const markdown = read(file)
      for (const line of fencedLines(markdown)) {
        if (/^\s*scripts\//.test(line)) offenders.push(`${file}: ${line}`)
        if (/^\s*<guide>\/scripts\//.test(line)) commands++
      }
      for (const match of markdown.matchAll(/`scripts\/[\w.-]+ [^`]*`/g)) {
        offenders.push(`${file}: ${match[0]}`)
      }
    }
    expect(offenders).toEqual([])
    expect(commands).toBeGreaterThan(4)
  })

  test("its scripts are executable", () => {
    for (const name of [
      "validate.sh",
      "run-headless.ts",
      "package.ts",
      "new.ts",
    ]) {
      const mode = statSync(join(SKILL, "scripts", name)).mode
      expect((mode & 0o111) !== 0, name).toBe(true)
    }
  })
})

describe("every file the guide ships", () => {
  const files = [...new Bun.Glob("**/*").scanSync(SKILL)].sort()

  test("is found, so the checks below cannot pass on nothing", () => {
    expect(files).toContain("SKILL.md")
    expect(files.length).toBeGreaterThan(20)
  })

  test("names the guide clockwork2 and no older name", () => {
    // It was `platform-game` while it lived at the repository's root, and an
    // agent told to load a guide by a name nothing installs finds nothing.
    const stale = files.filter((file) =>
      /platform-game/.test(readFileSync(join(SKILL, file), "utf8")),
    )
    expect(stale).toEqual([])
  })

  test("says nothing about the arcade", () => {
    // The arcade is archived. A game on the engine alone has no platform at
    // all, and one built with the vbz kit is checked by vbz's platform.
    const stale = files.filter((file) =>
      /\bthe arcade\b/i.test(readFileSync(join(SKILL, file), "utf8")),
    )
    expect(stale).toEqual([])
  })
})

describe("the scripts, on a game with data packs", () => {
  const scripts = join(SKILL, "scripts")

  test("package.ts prints a file under packs/ as a pack, and art as art", () => {
    const dir = mkdtempSync(join(tmpdir(), "cw2-scratch-package-"))
    try {
      mkdirSync(join(dir, "packs", "towns"), { recursive: true })
      writeFileSync(join(dir, "packs", "towns", "harbor.json"), "{}")
      writeFileSync(join(dir, "sprites.png"), "not really a png")
      const result = spawnSync("bun", [join(scripts, "package.ts"), dir], {
        encoding: "utf8",
      })
      expect(result.status).toBe(0)
      const printed = JSON.parse(result.stdout) as Array<{
        path: string
        requiredForSim: boolean
        bytes: number
      }>
      expect(
        printed.map(({ path, requiredForSim }) => [path, requiredForSim]),
      ).toEqual([
        ["packs/towns/harbor.json", true],
        ["sprites.png", false],
      ])
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test("run-headless.ts runs a game that reads a start pack and a demand pack", () => {
    const fixture = join(ENGINE, "fixtures/packs")
    const result = spawnSync(
      "bun",
      [join(scripts, "run-headless.ts"), fixture, "--quiet"],
      { encoding: "utf8" },
    )
    expect(result.stderr).toBe("")
    expect(result.stdout).toContain("completed at tick 1800")
  })
})

describe("references/failure-modes.md", () => {
  const source = read("references/failure-modes.md")
  const documented = new Set(
    [...source.matchAll(/^### (E_[A-Z_]+)$/gm)].map(
      (match) => match[1] as string,
    ),
  )
  const codes = new Set(Object.keys(ERROR_CODES))

  test("documents every error code the kernel can report", () => {
    const missing = [...codes].filter((code) => !documented.has(code)).sort()
    expect(missing).toEqual([])
  })

  test("documents no code that no longer exists", () => {
    const stale = [...documented].filter((code) => !codes.has(code)).sort()
    expect(stale).toEqual([])
  })
})

describe("references/kernel-api.md", () => {
  test("is up to date with the declarations it was generated from", () => {
    const result = spawnSync(
      "bun",
      ["run", join(REPOSITORY, "scripts/gen-skill-api.ts"), "--check"],
      { encoding: "utf8" },
    )
    expect(
      result.status,
      `${result.stdout}${result.stderr}`.trim() ||
        'run "bun run build" then "bun run scripts/gen-skill-api.ts"',
    ).toBe(0)
  })

  test("says nothing about the machine that generated it", () => {
    // The check above compares generated against committed, so it cannot see
    // that both are machine-specific: a heading naming a checkout path passes
    // on the machine that wrote it and fails everywhere else. That is exactly
    // what a namespace export used to produce, because its symbol resolves to
    // the module and the module's name is its file path.
    const source = read("references/kernel-api.md")
    const offenders = source
      .split("\n")
      .map((line, index) => ({ line, at: index + 1 }))
      .filter(({ line }) =>
        /\/home\/|\/Users\/|[A-Z]:\\|\/tmp\/|sourceMappingURL/.test(line),
      )
      .map(({ line, at }) => `${at}: ${line.trim()}`)
    expect(offenders).toEqual([])
  })
})

describe("the templates", () => {
  test("share one simulation, byte for byte", () => {
    // The point the templates exist to make: the renderer is a choice and the
    // simulation is not. A diff here means one of them drifted.
    const canvas = readFileSync(join(TEMPLATES, "canvas2d/src/sim.ts"), "utf8")
    const three = readFileSync(join(TEMPLATES, "three/src/sim.ts"), "utf8")
    expect(three).toBe(canvas)
  })

  for (const name of ["canvas2d", "three"]) {
    test(`${name} passes the conformance suite unmodified`, async () => {
      // The guide tells the reader the template conforms before they change
      // anything. This is that claim, run.
      const subject = await loadSubject(join(TEMPLATES, name, "src"))
      const report = await validate(subject)
      const failed = report.outcomes
        .filter((outcome) => !outcome.ok)
        .map(
          (outcome) => `${outcome.check}: ${outcome.findings[0]?.code ?? ""}`,
        )
      expect(failed).toEqual([])
      expect(report.ok).toBe(true)
    }, 60_000)
  }

  for (const name of ["canvas2d", "three"]) {
    test(`${name} declares the renderer it actually uses`, async () => {
      const subject = await loadSubject(join(TEMPLATES, name, "src"))
      const expected = name === "canvas2d" ? "canvas2d" : "three"
      expect(subject.manifest.capabilities.renderer).toBe(expected)
    })
  }
})
