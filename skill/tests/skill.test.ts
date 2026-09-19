/**
 * The skill, checked by machine.
 *
 * A skill is prose an agent follows literally, which makes stale prose worse
 * than none: the agent does exactly what the out-of-date sentence says. So
 * every claim in it that *can* be checked is checked here - the API reference
 * against the declarations it was generated from, the error-code sections
 * against the kernel's table, the templates against the conformance suite the
 * skill tells the reader to run.
 *
 * What none of this can check is whether the advice is any good. That is why
 * SKILL.md's first line says the script is right where the two disagree.
 */

import { describe, expect, test } from "bun:test"
import { spawnSync } from "node:child_process"
import { existsSync, readFileSync, statSync } from "node:fs"
import { join } from "node:path"
import { ERROR_CODES } from "@clockwork2/kernel"
import { loadSubject, validate } from "@clockwork2/validate"

const ROOT = join(import.meta.dir, "..")
const SKILL = join(ROOT, "platform-game")
const TEMPLATES = join(SKILL, "assets/templates")

function read(path: string): string {
  return readFileSync(join(SKILL, path), "utf8")
}

describe("SKILL.md", () => {
  const source = read("SKILL.md")
  const frontmatter = source.split("---")[1] ?? ""

  test("its name matches its directory", () => {
    const name = /^name: (.+)$/m.exec(frontmatter)?.[1]
    expect(name).toBe("platform-game")
    expect(name).toMatch(/^[a-z0-9-]{1,64}$/)
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

  test("every file it points at exists", () => {
    const referenced = [
      ...source.matchAll(/`((?:references|scripts)\/[\w.-]+)`/g),
    ]
      .map((match) => match[1] as string)
      .filter((path) => /\.\w+$/.test(path))
    expect(referenced.length).toBeGreaterThan(8)
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
      ["run", join(ROOT, "../scripts/gen-skill-api.ts"), "--check"],
      { encoding: "utf8" },
    )
    expect(
      result.status,
      `${result.stdout}${result.stderr}`.trim() ||
        'run "bun run build" then "bun run scripts/gen-skill-api.ts"',
    ).toBe(0)
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
      // The skill tells the reader the template conforms before they change
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
