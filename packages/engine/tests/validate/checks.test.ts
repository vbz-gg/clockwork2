/**
 * The checks, driven one at a time against a Subject built by hand.
 *
 * Every check also has a fixture under fixtures/, and that is the better test
 * where it is possible: a fixture goes through the real loader and proves the
 * whole path. These are the branches a fixture cannot reach.
 *
 * Three reasons a branch lands here rather than in a fixture. Some guard
 * against a Subject the loader does not build, because `loadSubject` always
 * sets `entry` and `root` and always puts the manifest through
 * `assertManifest`; they are defence in depth and only a hand-built Subject can
 * enter them. Some depend on the environment rather than on the game, like the
 * headless check's own refusal to run in a browser-shaped runtime. And one,
 * the performance budget, would otherwise be a fixture that has to be slow -
 * a test whose outcome depends on how fast the machine is, which AGENTS.md is
 * explicit is the flake rather than the finding. A negative budget gets the
 * same branch with no timing in it at all.
 */

import { afterEach, describe, expect, test } from "bun:test"
import { createHash } from "node:crypto"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type {
  Counters,
  Effect,
  GameModule,
  Manifest,
  PackReader,
  Snapshot,
} from "../../src"
import { CHECKS } from "../../src/validate/checks/index"
import type { CheckOutcome, Subject } from "../../src/validate/types"

function manifest(over: Partial<Manifest> = {}): Manifest {
  return {
    schemaVersion: 1,
    id: "stub",
    version: "1.0.0",
    name: "Stub",
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
    ...over,
  } as Manifest
}

/** A game that conforms, so anything a check reports came from the change. */
class StubGame implements GameModule {
  readonly manifest: Manifest
  protected ticks = 0
  constructor(m: Manifest = manifest()) {
    this.manifest = m
  }
  init(): void {
    this.ticks = 0
  }
  tick(): void {
    this.ticks++
  }
  view(): unknown {
    return { ticks: this.ticks }
  }
  snapshot(): Snapshot {
    return { ticks: this.ticks }
  }
  restore(snapshot: Snapshot): void {
    this.ticks = snapshot.ticks as number
  }
  score(): Counters {
    return { score: this.ticks, ticksSurvived: this.ticks }
  }
  isOver(): boolean {
    return this.ticks >= 120
  }
  effects(): readonly Effect[] {
    return []
  }
}

function subjectFor(
  make: () => GameModule,
  over: Partial<Subject> = {},
): Subject {
  return { manifest: manifest(), load: () => make(), ...over }
}

async function runCheck(
  name: string,
  subject: Subject,
  seeds: readonly string[] = ["s1"],
): Promise<Omit<CheckOutcome, "check" | "title" | "ms">> {
  const check = CHECKS.find((c) => c.name === name)
  if (check === undefined) throw new Error(`no check named ${name}`)
  return await check.run({ subject, seeds, shims: true })
}

const restores: Array<() => void> = []
afterEach(() => {
  while (restores.length > 0) restores.pop()?.()
})

/** The house idiom: install on globalThis, restore in afterEach. */
function install(name: string, value: unknown): void {
  const target = globalThis as Record<string, unknown>
  const had = name in target
  const saved = target[name]
  target[name] = value
  restores.push(() => {
    if (had) target[name] = saved
    else delete target[name]
  })
}

describe("a check with nothing to look at says so instead of passing quietly", () => {
  /**
   * `loadSubject` always sets these, so only a caller assembling a Subject
   * itself gets here - the platform validating a module it already holds, with
   * no directory behind it. Reporting a pass would say the bundle was scanned
   * when nothing was.
   */
  test("banned-apis skips when there is no entry file", async () => {
    const outcome = await runCheck(
      "banned-apis",
      subjectFor(() => new StubGame()),
    )
    expect(outcome.skipped).toContain("no entry file")
    expect(outcome.ok).toBe(true)
    expect(outcome.findings).toEqual([])
  })

  test("budgets skips when there is no bundle directory", async () => {
    const outcome = await runCheck(
      "budgets",
      subjectFor(() => new StubGame()),
    )
    expect(outcome.skipped).toContain("no bundle directory")
    expect(outcome.ok).toBe(true)
  })

  test("render-smoke says which suite does hold it", async () => {
    const outcome = await runCheck(
      "render-smoke",
      subjectFor(() => new StubGame()),
    )
    // A skip that does not say where the real check lives reads as a gap.
    expect(outcome.skipped).toContain("e2e")
    expect(outcome.ok).toBe(true)
  })
})

describe("banned-apis", () => {
  /**
   * An import the scan cannot resolve is reported rather than ignored. A scan
   * that stayed quiet would pass a bundle whose banned call sits one
   * unresolvable import away, which is all it would take to get past it.
   *
   * The file is written to a temp directory rather than kept under tests/,
   * because tsconfig.tests.json type-checks everything there and an import of
   * a module that does not exist would fail the typecheck.
   */
  test("an import it cannot resolve is a finding, not a silence", async () => {
    const dir = mkdtempSync(join(tmpdir(), "cw2-scratch-unresolved-"))
    restores.push(() => rmSync(dir, { recursive: true, force: true }))
    const entry = join(dir, "index.ts")
    writeFileSync(entry, 'import "./nowhere-at-all"\nexport default {}\n')

    const outcome = await runCheck(
      "banned-apis",
      subjectFor(() => new StubGame(), { entry }),
    )
    expect(outcome.ok).toBe(false)
    expect(outcome.findings.map((f) => f.code)).toEqual(["E_LINT_BANNED"])
    expect(outcome.findings[0]?.detail).toContain("could not resolve")
    expect(outcome.findings[0]?.detail).toContain("nowhere-at-all")
  })
})

describe("headless", () => {
  /**
   * The check proves a game runs with no DOM. Under a runtime that has one it
   * proves nothing, so it refuses rather than passing - otherwise a browser
   * test runner would report a green headless check for a game that cannot run
   * headless at all.
   */
  test("refuses to run where a window exists", async () => {
    install("window", {})
    const outcome = await runCheck(
      "headless",
      subjectFor(() => new StubGame()),
    )
    expect(outcome.ok).toBe(false)
    expect(outcome.findings.map((f) => f.code)).toContain("E_HEADLESS_THREW")
    expect(outcome.findings[0]?.detail).toContain("not a headless environment")
  })

  test("names the global it found, so the fix is obvious", async () => {
    install("document", {})
    const outcome = await runCheck(
      "headless",
      subjectFor(() => new StubGame()),
    )
    expect(outcome.findings[0]?.detail).toContain("document")
  })
})

describe("no-async", () => {
  /**
   * The scan misses a promise built without the keywords, so the check hashes
   * the state, drains the microtask queue and hashes again. This game queues
   * its work in a `then` off a resolved promise, which no amount of reading the
   * source for `async` or `await` would find.
   */
  test("catches state that moves while the microtask queue drains", async () => {
    class LatePromiseGame extends StubGame {
      private settled = 0
      override tick(): void {
        super.tick()
        void Promise.resolve().then(() => {
          this.settled++
        })
      }
      override snapshot(): Snapshot {
        return { ticks: this.ticks, settled: this.settled }
      }
      override restore(snapshot: Snapshot): void {
        super.restore(snapshot)
        this.settled = snapshot.settled as number
      }
    }
    const outcome = await runCheck(
      "no-async",
      subjectFor(() => new LatePromiseGame()),
    )
    expect(outcome.ok).toBe(false)
    expect(outcome.findings.map((f) => f.code)).toEqual(["E_ASYNC_DETECTED"])
    expect(outcome.findings[0]?.detail).toContain("microtask queue drained")
  })
})

describe("restore", () => {
  /**
   * Resuming from a snapshot has to end where the uninterrupted run ended.
   * This game spends fuel every tick and forgets it in the snapshot, so a
   * resumed run starts again with a full tank and survives longer. The end tick
   * is reported on its own rather than as a checkpoint divergence, because
   * "ended at a different tick" is the more useful sentence of the two.
   */
  test("a resumed run ending elsewhere is reported by its end tick", async () => {
    class ForgetfulFuelGame extends StubGame {
      private fuel = 90
      override init(): void {
        super.init()
        this.fuel = 90
      }
      override tick(): void {
        super.tick()
        this.fuel--
      }
      override snapshot(): Snapshot {
        return { ticks: this.ticks }
      }
      override isOver(): boolean {
        return this.fuel <= 0
      }
    }
    const outcome = await runCheck(
      "restore",
      subjectFor(() => new ForgetfulFuelGame()),
    )
    expect(outcome.ok).toBe(false)
    expect(outcome.findings.map((f) => f.code)).toContain("E_RESTORE_MISMATCH")
    expect(outcome.findings.some((f) => f.detail.includes("ended at"))).toBe(
      true,
    )
  })
})

describe("determinism", () => {
  /**
   * Two runs of one seed have to end at the same tick. A run that ends
   * somewhere else is reported as its own difference rather than as a pile of
   * mismatched checkpoints, because the end tick names the fault directly.
   *
   * The Subject hands out a game whose ending moves with how many times it has
   * been loaded, which is what a module-level counter does to a real bundle.
   */
  test("runs that end at different ticks are reported by end tick", async () => {
    let loads = 0
    class DriftingGame extends StubGame {
      private readonly limit: number
      constructor(limit: number) {
        super()
        this.limit = limit
      }
      override isOver(): boolean {
        return this.ticks >= this.limit
      }
    }
    const outcome = await runCheck("determinism", {
      manifest: manifest(),
      load: () => new DriftingGame(60 + 30 * loads++),
    })
    expect(outcome.ok).toBe(false)
    expect(outcome.findings.map((f) => f.code)).toContain(
      "E_DETERMINISM_DIVERGED",
    )
    expect(
      outcome.findings.some((f) => f.detail.includes("the first run ended at")),
    ).toBe(true)
  })
})

describe("performance", () => {
  /**
   * A budget of -1 microseconds per tick cannot be met by any run, so this
   * reaches the finding without depending on how fast the machine is. A fixture
   * that had to be slow enough to blow a real budget would pass or fail with
   * the hardware.
   */
  test("a tick over its budget is reported with the measurement", async () => {
    const outcome = await runCheck(
      "performance",
      subjectFor(() => new StubGame(), {
        manifest: manifest({ budgets: { microsecondsPerTick: -1 } }),
      }),
    )
    expect(outcome.ok).toBe(false)
    expect(outcome.findings.map((f) => f.code)).toEqual(["E_PERF_BUDGET"])
    expect(outcome.findings[0]?.detail).toContain("microseconds per tick")
    expect(outcome.findings[0]?.detail).toContain("budget is -1")
  })

  test("reports peak memory, which sees a typed array the heap counters miss", () => {
    // Each game in a fresh process of its own, so neither earlier tests'
    // garbage nor the other game's freed pages can move the numbers. One game
    // keeps 32 MiB of level data in a typed array from init; it must report
    // at least 24 MiB more than one that keeps nothing.
    const dir = mkdtempSync(join(tmpdir(), "cw2-scratch-memory-"))
    restores.push(() => rmSync(dir, { recursive: true, force: true }))
    const runner = join(import.meta.dir, "../../src/validate/runner.ts")
    const script = join(dir, "measure.ts")
    writeFileSync(
      script,
      `import { validate } from ${JSON.stringify(runner)}
const manifest = ${JSON.stringify(manifest())}
const megabytes = Number(process.argv[2])
function game() {
  let keep = null
  let ticks = 0
  return {
    manifest,
    init() { ticks = 0; keep = megabytes === 0 ? null : new Uint8Array(megabytes * 1048576).fill(1) },
    tick() { ticks++; if (keep !== null) keep[ticks % keep.length] = ticks & 255 },
    view: () => ({ ticks }),
    snapshot: () => ({ ticks }),
    restore(s) { ticks = s.ticks },
    score: () => ({ score: 0, ticksSurvived: ticks }),
    isOver: () => ticks >= 600,
    effects: () => [],
  }
}
const report = await validate({ manifest, load: () => game() }, { only: ["performance"], seeds: ["m"] })
console.log(JSON.stringify(report.outcomes[0].measurements))
`,
    )
    const measure = (megabytes: number) => {
      const child = Bun.spawnSync(
        [process.execPath, script, String(megabytes)],
        { stdout: "pipe", stderr: "pipe" },
      )
      expect(child.stderr.toString()).toBe("")
      return JSON.parse(child.stdout.toString()) as {
        peakMemoryBytes: number
        memoryEngine: string
        ticks: number
      }
    }
    const small = measure(0)
    const big = measure(32)
    expect(big.peakMemoryBytes - small.peakMemoryBytes).toBeGreaterThan(
      24 * 1048576,
    )
    expect(small.memoryEngine).toMatch(/^JavaScriptCore, Bun \d/)
    expect(big.ticks).toBe(600)
  })

  test("a budget it meets is not a finding", async () => {
    const outcome = await runCheck(
      "performance",
      subjectFor(() => new StubGame(), {
        manifest: manifest({ budgets: { microsecondsPerTick: 1_000_000 } }),
      }),
    )
    expect(outcome.ok).toBe(true)
    expect(outcome.note).toContain("ticks in")
  })
})

describe("replay", () => {
  /**
   * The recording the check builds carries fields straight off the manifest,
   * and the codec has its own rules about them. An empty kernel version passes
   * nothing the loader would let through, but a check that let the decode throw
   * escape would be reported as a crashed check rather than as the unusable
   * recording it is.
   */
  test("a recording that will not decode is a replay finding, not a crash", async () => {
    const outcome = await runCheck(
      "replay",
      subjectFor(() => new StubGame(), {
        manifest: manifest({ kernel: { version: "" } }),
      }),
    )
    expect(outcome.ok).toBe(false)
    expect(outcome.findings.map((f) => f.code)).toEqual(["E_REPLAY_MISMATCH"])
    expect(outcome.findings[0]?.detail).toContain(
      "did not survive a round trip",
    )
  })

  /**
   * The check records one run and replays another from the decoded log. A game
   * that behaves differently the second time it is loaded is exactly what the
   * comparison is for, and the finding has to carry the tick it parted company
   * so the report points somewhere.
   */
  test("a replay that diverges reports where", async () => {
    let loads = 0
    class SecondTimeDifferentGame extends StubGame {
      private readonly bonus: number
      constructor(bonus: number) {
        super()
        this.bonus = bonus
      }
      override score(): Counters {
        return { score: this.ticks + this.bonus, ticksSurvived: this.ticks }
      }
    }
    const outcome = await runCheck("replay", {
      manifest: manifest(),
      load: () => new SecondTimeDifferentGame(loads++ === 0 ? 0 : 7),
    })
    expect(outcome.ok).toBe(false)
    expect(outcome.findings.map((f) => f.code)).toEqual(["E_REPLAY_MISMATCH"])
    expect(outcome.findings[0]?.detail).toContain("seed s1")
  })
})

describe("manifest", () => {
  /**
   * `loadSubject` puts every manifest through `assertManifest` and throws, so a
   * malformed manifest never reaches this check through the loader. It is still
   * the check's job: a platform that holds a manifest from anywhere else asks
   * this, and a validator that trusted its caller would have no answer.
   */
  test("every schema issue is reported as E_MANIFEST_SCHEMA", async () => {
    const outcome = await runCheck(
      "manifest",
      subjectFor(() => new StubGame(), {
        manifest: manifest({
          id: "",
          tiePolicy: "whoever-asked-first",
        } as unknown as Partial<Manifest>),
      }),
    )
    expect(outcome.ok).toBe(false)
    expect(new Set(outcome.findings.map((f) => f.code))).toEqual(
      new Set(["E_MANIFEST_SCHEMA"]),
    )
    const details = outcome.findings.map((f) => f.detail).join("\n")
    expect(details).toContain("id")
    expect(details).toContain("tiePolicy")
  })

  test("a valid manifest with no entry to scan passes", async () => {
    const outcome = await runCheck(
      "manifest",
      subjectFor(() => new StubGame()),
    )
    expect(outcome.ok).toBe(true)
    expect(outcome.findings).toEqual([])
  })
})

describe("determinism with demand packs", () => {
  const level = new TextEncoder().encode('{"bonus":1}')
  const packManifest = manifest({
    assets: [
      {
        path: "data/level.json",
        sha256: createHash("sha256").update(level).digest("hex"),
        bytes: level.byteLength,
        requiredForSim: true,
        load: "demand",
        license: "CC0-1.0",
      },
    ],
  })

  /** Names the level from tick 30; `impure` makes asking change the state. */
  class DemandGame extends StubGame {
    private reader: PackReader | null = null
    /** How often packsNeeded() was asked: state, when the game is impure. */
    private asked = 0
    constructor(private readonly impure = false) {
      super(packManifest)
    }
    override snapshot(): Snapshot {
      return { ticks: this.ticks, asked: this.asked }
    }
    override init(_seed?: string, _config?: unknown, packs?: PackReader): void {
      super.init()
      this.reader = packs ?? null
    }
    override tick(): void {
      if (this.ticks >= 30) this.reader?.json("data/level.json")
      super.tick()
    }
    packsNeeded(): readonly string[] {
      if (this.impure) this.asked++
      return this.ticks >= 30 ? ["data/level.json"] : []
    }
  }

  const subject = (
    impure: boolean,
    packs = new Map([["data/level.json", level]]),
  ) =>
    subjectFor(() => new DemandGame(impure), { manifest: packManifest, packs })

  test("a pure packsNeeded() passes, with the on-demand run counted", async () => {
    const outcome = await runCheck("determinism", subject(false))
    expect(outcome.findings).toEqual([])
    expect(outcome.note).toBe("10 runs compared")
  })

  test("a packsNeeded() that changes the state is named as the cause", async () => {
    const outcome = await runCheck("determinism", subject(true))
    const details = outcome.findings.map((f) => f.detail).join("\n")
    expect(outcome.findings.map((f) => f.code)).toContain(
      "E_DETERMINISM_DIVERGED",
    )
    expect(details).toContain("packsNeeded() changed the state")
  })

  test("a packsNeeded() that fails when asked twice is a finding, not a crash", async () => {
    class Fragile extends DemandGame {
      private lastAsked = -1
      override packsNeeded(): readonly string[] {
        if (this.lastAsked === this.ticks) throw new Error("asked twice")
        this.lastAsked = this.ticks
        return super.packsNeeded()
      }
    }
    const outcome = await runCheck(
      "determinism",
      subjectFor(() => new Fragile(), {
        manifest: packManifest,
        packs: new Map([["data/level.json", level]]),
      }),
    )
    expect(outcome.findings.map((f) => f.code)).toEqual([
      "E_DETERMINISM_DIVERGED",
    ])
    expect(outcome.findings[0]?.detail).toContain("asked twice")
  })

  test("a demand pack the bundle does not have is reported with its code", async () => {
    const outcome = await runCheck("determinism", subject(false, new Map()))
    expect(new Set(outcome.findings.map((f) => f.code))).toEqual(
      new Set(["E_PACK_NOT_DELIVERED"]),
    )
  })
})
