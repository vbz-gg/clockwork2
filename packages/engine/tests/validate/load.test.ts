/**
 * Loading a bundle from a directory.
 *
 * Every case here is a layout a submitter might actually ship, and the failure
 * mode is always the same shape: a bundle that is refused for the wrong reason,
 * or accepted when its manifest is not the one that will be judged. The
 * messages matter as much as the codes, because a submitter reads them and has
 * no access to this repository.
 *
 * The bundles are written to a temp directory rather than kept under fixtures/,
 * so that "no default export" and "no entry file" can be real rather than
 * described - tsconfig.tests.json type-checks everything under tests/, and
 * fixtures/ is walked by the suite that expects every directory there to load.
 */

import { afterEach, describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { isClockworkError } from "../../src"
import { findEntry, loadSubject } from "../../src/validate/load"

const MANIFEST_LITERAL = `{
  schemaVersion: 1,
  id: "temp-bundle",
  version: "1.0.0",
  name: "Temp Bundle",
  kernel: { version: "0.1.0" },
  session: { tickHz: 60, maxTicks: 600, maxWallSeconds: 120, hasEnding: true },
  inputs: { map: { push: [{ code: "Space", device: "key" }] } },
  counters: [
    { name: "score", direction: "up", monotonic: true },
    { name: "ticksSurvived", direction: "up", monotonic: true },
  ],
  rankBy: ["score"],
  tiePolicy: "shared",
  capabilities: {
    deterministic: true,
    physics: "none",
    renderer: "canvas2d",
    multiplayer: false,
  },
}`

/** A game body with the manifest supplied separately, or not at all. */
function gameSource(options: {
  readonly manifest?: string
  readonly exportAs: "default" | "createGame" | "Game" | "none"
  readonly manifestExport?: "MANIFEST" | "manifest"
}): string {
  const manifestOn =
    options.manifest === undefined ? "undefined" : options.manifest
  const named =
    options.manifestExport === undefined
      ? ""
      : `export const ${options.manifestExport} = ${manifestOn}\n`
  const body = `class TheGame {
  manifest = ${manifestOn}
  ticks = 0
  init() { this.ticks = 0 }
  tick() { this.ticks++ }
  view() { return { ticks: this.ticks } }
  snapshot() { return { ticks: this.ticks } }
  restore(s) { this.ticks = s.ticks }
  score() { return { score: 0, ticksSurvived: this.ticks } }
  isOver() { return this.ticks >= 60 }
  effects() { return [] }
}
`
  const exported =
    options.exportAs === "none"
      ? "export const notTheDefault = TheGame\n"
      : options.exportAs === "default"
        ? "export default function make() { return new TheGame() }\n"
        : `export function ${options.exportAs}() { return new TheGame() }\n`
  return `${named}${body}${exported}`
}

const dirs: string[] = []
afterEach(() => {
  while (dirs.length > 0) {
    rmSync(dirs.pop() as string, { recursive: true, force: true })
  }
})

function bundle(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), "cw2-scratch-bundle-"))
  dirs.push(dir)
  for (const [path, contents] of Object.entries(files)) {
    const full = join(dir, path)
    mkdirSync(join(full, ".."), { recursive: true })
    writeFileSync(full, contents)
  }
  return dir
}

async function codeOf(run: () => Promise<unknown>): Promise<string> {
  try {
    await run()
  } catch (error) {
    return isClockworkError(error)
      ? error.code
      : `not a ClockworkError: ${String(error)}`
  }
  return "(it did not throw)"
}

describe("findEntry", () => {
  test("finds each layout a bundle may use", () => {
    for (const name of ["index.ts", "index.js", "index.mjs", "src/index.ts"]) {
      const dir = bundle({ [name]: "export default {}\n" })
      expect(findEntry(dir)).toBe(join(dir, name))
    }
  })

  test("prefers index.ts when a bundle ships more than one", () => {
    // Otherwise which file is judged depends on readdir order.
    const dir = bundle({
      "index.js": "export default {}\n",
      "index.ts": "export default {}\n",
      "src/index.ts": "export default {}\n",
    })
    expect(findEntry(dir)).toBe(join(dir, "index.ts"))
  })

  test("a path straight to a file is taken as the entry", () => {
    const dir = bundle({ "game.ts": "export default {}\n" })
    expect(findEntry(join(dir, "game.ts"))).toBe(join(dir, "game.ts"))
  })

  /**
   * The failure this pins: findEntry used to fall back to returning the
   * directory, so a bundle shipped with no entry file got `Cannot find module
   * /path/to/bundle` from the import rather than the message that names the
   * filenames it looked for. The submitter reading that has nothing to act on.
   */
  test("a directory with no entry is refused, by the names it looked for", async () => {
    const dir = bundle({ "readme.txt": "nothing to run here\n" })
    expect(await codeOf(async () => findEntry(dir))).toBe("E_SUBJECT_LOAD")
    try {
      findEntry(dir)
    } catch (error) {
      expect(String(error)).toContain("index.ts")
      expect(String(error)).toContain("src/index.ts")
      expect(String(error)).not.toContain("Cannot find module")
    }
  })

  test("and loadSubject reports that code rather than an import error", async () => {
    const dir = bundle({ "readme.txt": "nothing to run here\n" })
    expect(await codeOf(() => loadSubject(dir))).toBe("E_SUBJECT_LOAD")
  })

  test("a path that does not exist is refused, not resolved to nothing", async () => {
    expect(
      await codeOf(async () =>
        findEntry(join(tmpdir(), "cw2-not-here-at-all")),
      ),
    ).toBe("E_SUBJECT_LOAD")
  })
})

describe("which export is the game", () => {
  test("a default export", async () => {
    const dir = bundle({
      "index.ts": gameSource({
        manifest: MANIFEST_LITERAL,
        exportAs: "default",
      }),
    })
    const subject = await loadSubject(dir)
    expect(subject.manifest.id).toBe("temp-bundle")
  })

  test("createGame, for a bundle that names its factory", async () => {
    const dir = bundle({
      "index.ts": gameSource({
        manifest: MANIFEST_LITERAL,
        exportAs: "createGame",
      }),
    })
    expect((await loadSubject(dir)).manifest.id).toBe("temp-bundle")
  })

  test("Game, for a bundle that exports the class", async () => {
    const dir = bundle({
      "index.ts": gameSource({ manifest: MANIFEST_LITERAL, exportAs: "Game" }),
    })
    expect((await loadSubject(dir)).manifest.id).toBe("temp-bundle")
  })

  test("an entry with none of the three is refused, and says what to export", async () => {
    const dir = bundle({
      "index.ts": gameSource({ manifest: MANIFEST_LITERAL, exportAs: "none" }),
    })
    expect(await codeOf(() => loadSubject(dir))).toBe("E_SUBJECT_LOAD")
    try {
      await loadSubject(dir)
    } catch (error) {
      expect(String(error)).toContain("default")
    }
  })
})

describe("which manifest is judged", () => {
  test("a MANIFEST export is used", async () => {
    const dir = bundle({
      "index.ts": gameSource({
        manifest: MANIFEST_LITERAL,
        exportAs: "default",
        manifestExport: "MANIFEST",
      }),
    })
    expect((await loadSubject(dir)).manifest.name).toBe("Temp Bundle")
  })

  /**
   * A bundle with no manifest in its code can ship manifest.json instead. The
   * failure mode this guards is a bundle accepted with no manifest at all,
   * which would then be ranked against counters nobody declared.
   */
  test("manifest.json on disk is used when the module exports none", async () => {
    const dir = bundle({
      "index.ts": gameSource({ exportAs: "default" }),
      "manifest.json": JSON.stringify({
        schemaVersion: 1,
        id: "from-disk",
        version: "1.0.0",
        name: "From Disk",
        kernel: { version: "0.1.0" },
        session: {
          tickHz: 60,
          maxTicks: 600,
          maxWallSeconds: 120,
          hasEnding: true,
        },
        inputs: { map: { push: [{ code: "Space", device: "key" }] } },
        counters: [
          { name: "score", direction: "up", monotonic: true },
          { name: "ticksSurvived", direction: "up", monotonic: true },
        ],
        rankBy: ["score"],
        tiePolicy: "shared",
        capabilities: {
          deterministic: true,
          physics: "none",
          renderer: "canvas2d",
          multiplayer: false,
        },
      }),
    })
    expect((await loadSubject(dir)).manifest.id).toBe("from-disk")
  })

  test("no manifest anywhere is refused rather than defaulted", async () => {
    const dir = bundle({ "index.ts": gameSource({ exportAs: "default" }) })
    expect(await codeOf(() => loadSubject(dir))).toBe("E_MANIFEST_INVALID")
  })
})

describe("the Subject that comes back", () => {
  test("carries the entry and the root, which two checks need", async () => {
    // banned-apis skips without `entry` and budgets skips without `root`, so a
    // loader that left either out would quietly stop running two checks.
    const dir = bundle({
      "index.ts": gameSource({
        manifest: MANIFEST_LITERAL,
        exportAs: "default",
      }),
    })
    const subject = await loadSubject(dir)
    expect(subject.entry).toBe(join(dir, "index.ts"))
    expect(subject.root).toBe(dir)
  })

  test("carries a config only when one was given", async () => {
    const dir = bundle({
      "index.ts": gameSource({
        manifest: MANIFEST_LITERAL,
        exportAs: "default",
      }),
    })
    expect("config" in (await loadSubject(dir))).toBe(false)
    const withConfig = await loadSubject(dir, { config: { speed: 2 } })
    expect(withConfig.config).toEqual({ speed: 2 })
  })

  /**
   * The point of the whole loader: `fresh` re-evaluates the module, so a
   * module-level counter starts again. A fresh instance of one evaluation would
   * not, and that is what made two runs of one seed diverge.
   */
  test("load({ fresh: true }) re-evaluates, so module state starts again", async () => {
    const dir = bundle({
      "index.ts": `let created = 0
export const MANIFEST = ${MANIFEST_LITERAL}
class Game {
  manifest = MANIFEST
  id = ++created
  ticks = 0
  init() { this.ticks = 0 }
  tick() { this.ticks++ }
  view() { return {} }
  snapshot() { return { ticks: this.ticks } }
  restore(s) { this.ticks = s.ticks }
  score() { return { score: this.id, ticksSurvived: this.ticks } }
  isOver() { return this.ticks >= 60 }
  effects() { return [] }
}
export default function make() { return new Game() }
`,
    })
    const subject = await loadSubject(dir)
    const a = await subject.load({ fresh: true })
    const b = await subject.load({ fresh: true })
    expect(b.score()).toEqual(a.score())

    const c = await subject.load()
    const d = await subject.load()
    expect(d.score()).not.toEqual(c.score())
  })
})
