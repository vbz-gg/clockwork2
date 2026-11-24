/**
 * Every check has to pass on a conforming game and fail on its matching
 * non-conformant neighbour, with the exact documented code.
 *
 * This is what keeps the agent skill's failure-modes reference honest. A code
 * that stops being produced breaks a test here rather than quietly becoming
 * prose that describes nothing.
 */

import { describe, expect, test } from "bun:test"
import { join } from "node:path"
import createSeedConverges, {
  ENDS_AT as SEED_CONVERGES_ENDS_AT,
} from "../../fixtures/seed-converges/index"
import {
  type ErrorCode,
  RecordedInputSource,
  runSession,
  type SessionResult,
} from "../../src"
import { packReaderFor } from "../../src/testing"
import {
  CHECK_SETS,
  CHECK_WINDOW_TICKS,
  type CheckSet,
  SENSITIVITY_SEEDS,
  SENSITIVITY_TICKS,
} from "../../src/validate"
import { loadSubject } from "../../src/validate/load"
import { formatReport, validate } from "../../src/validate/runner"

const FIXTURES = join(import.meta.dir, "../../fixtures")

/** Every code a set of checks reports for a fixture. */
async function codesFor(
  fixture: string,
  set: CheckSet,
): Promise<Set<ErrorCode>> {
  const subject = await loadSubject(join(FIXTURES, fixture))
  const report = await validate(subject, { set, seeds: ["t1"] })
  const codes = new Set<ErrorCode>()
  for (const outcome of report.outcomes) {
    for (const finding of outcome.findings) codes.add(finding.code)
  }
  return codes
}

describe("the conforming fixture", () => {
  test("passes every check, the ranked set's included", async () => {
    const subject = await loadSubject(join(FIXTURES, "conforming"))
    const report = await validate(subject, {
      set: "ranked",
      seeds: ["t1", "t2"],
    })
    const failures = report.outcomes.filter((o) => !o.ok)
    expect(
      failures.map(
        (o) => `${o.check}: ${o.findings.map((f) => f.detail).join("; ")}`,
      ),
    ).toEqual([])
    expect(report.ok).toBe(true)
  }, 30_000)

  test("every check in each set ran or said why it did not", async () => {
    const subject = await loadSubject(join(FIXTURES, "conforming"))
    for (const [set, count] of [
      ["every-game", 11],
      ["ranked", 13],
    ] as const) {
      const report = await validate(subject, { set, seeds: ["t1"] })
      expect(report.set).toBe(set)
      expect(report.outcomes.map((o) => o.check)).toEqual(
        CHECK_SETS[set].map((check) => check.name),
      )
      expect(report.outcomes.length).toBe(count)
      for (const outcome of report.outcomes) {
        expect(outcome.ok || outcome.skipped !== undefined, outcome.check).toBe(
          true,
        )
      }
    }
  }, 30_000)
})

describe("the conforming fixture with data packs", () => {
  test("passes every check, and the extra determinism run happened", async () => {
    const subject = await loadSubject(join(FIXTURES, "packs"))
    expect([...(subject.packs?.keys() ?? [])]).toEqual([
      "data/rules.json",
      "data/level-2.json",
    ])
    const report = await validate(subject, {
      set: "ranked",
      seeds: ["t1", "t2"],
    })
    const failures = report.outcomes.filter((o) => !o.ok)
    expect(
      failures.map(
        (o) => `${o.check}: ${o.findings.map((f) => f.detail).join("; ")}`,
      ),
    ).toEqual([])
    expect(report.outcomes.length).toBe(13)
    // Two seeds, three logs, three runs each, and the on-demand run.
    const determinism = report.outcomes.find((o) => o.check === "determinism")
    expect(determinism?.note).toBe("19 runs compared")
    // The restore check resumes at half the run, after the pack opened.
    const restore = report.outcomes.find((o) => o.check === "restore")
    expect(restore?.note).toContain("900")
  }, 60_000)
})

describe("the conforming fixture with two seats", () => {
  test("passes every check, and is played once more through a seated source", async () => {
    const subject = await loadSubject(join(FIXTURES, "seats"))
    const report = await validate(subject, {
      set: "every-game",
      seeds: ["t1", "t2"],
    })
    const failures = report.outcomes.filter((o) => !o.ok && !o.skipped)
    expect(
      failures.map(
        (o) => `${o.check}: ${o.findings.map((f) => f.detail).join("; ")}`,
      ),
    ).toEqual([])
    // Three runs of three logs for each of two seeds, and the two seated
    // runs: the log split by seat, then each seat's share played back.
    const determinism = report.outcomes.find((o) => o.check === "determinism")
    expect(determinism?.note).toBe("20 runs compared")
  }, 30_000)

  test("a one-seat game is not played through one, so its count is what it was", async () => {
    const subject = await loadSubject(join(FIXTURES, "conforming"))
    const report = await validate(subject, {
      set: "every-game",
      seeds: ["t1", "t2"],
      only: ["determinism"],
    })
    expect(report.outcomes[0]?.note).toBe("18 runs compared")
  }, 30_000)
})

describe("each non-conformant fixture reports its own code", () => {
  const CASES: Array<[fixture: string, expected: ErrorCode[]]> = [
    // Both layers fire: the static scan sees the call, the runtime trap sees
    // it happen. Neither is enough alone, which is why both are there.
    ["banned-math", ["E_LINT_BANNED", "E_BANNED_API"]],
    ["banned-clock", ["E_LINT_BANNED", "E_BANNED_API"]],
    ["banned-pow", ["E_LINT_BANNED", "E_BANNED_API"]],
    ["async-tick", ["E_ASYNC_DETECTED", "E_ASYNC_TICK"]],
    ["incomplete-snapshot", ["E_RESTORE_MISMATCH"]],
    // Four ways one asset declaration can be wrong, all at once.
    ["budget-overrun", ["E_BUDGET_EXCEEDED"]],
    // The kernel refuses a reversed monotone counter mid-run, so every check
    // that drives a session reports the code the run died of rather than its
    // own fallback.
    ["counter-reversed", ["E_COUNTER_REVERSED"]],
    ["counter-fractional", ["E_COUNTER_RANGE"]],
    // Both layers again: the scan refuses the name, and the manifest check
    // separates out the four that reach the embedder specifically.
    ["globals-touched", ["E_LINT_BANNED", "E_GLOBALS_TOUCHED"]],
    // Data packs. A pack that is absent or wrong also fails the budgets
    // check, which reads the same files from disk.
    ["pack-undeclared", ["E_PACK_UNDECLARED"]],
    ["pack-not-requested", ["E_PACK_NOT_REQUESTED"]],
    ["pack-missing", ["E_PACK_NOT_DELIVERED", "E_BUDGET_EXCEEDED"]],
    ["pack-hash-mismatch", ["E_PACK_HASH_MISMATCH", "E_BUDGET_EXCEEDED"]],
    ["pack-too-large", ["E_PACK_TOO_LARGE", "E_BUDGET_EXCEEDED"]],
    // Seats. A game that cannot say whose turn a tick is, or names a seat
    // the run does not have, fails every check that runs it with the
    // kernel's code. A seat() that changes state agrees with itself run to
    // run, and the extra call the determinism check makes is what shows it;
    // the restore check sees it too, because a resumed run asks once fewer.
    ["seat-missing", ["E_SEAT_INVALID"]],
    ["seat-out-of-range", ["E_SEAT_INVALID"]],
    ["seat-impure", ["E_DETERMINISM_DIVERGED", "E_RESTORE_MISMATCH"]],
  ]

  for (const [fixture, expected] of CASES) {
    test(`${fixture} reports ${expected.join(" and ")}`, async () => {
      const codes = await codesFor(fixture, "every-game")
      expect([...codes].sort()).toEqual([...expected].sort())
    }, 30_000)
  }

  // The ranked set's two, which every check a game needs passes.
  const RANKED: Array<[fixture: string, expected: ErrorCode]> = [
    ["seed-ignored", "E_SEED_IGNORED"],
    ["unranked", "E_RANK_UNDECLARED"],
  ]

  for (const [fixture, expected] of RANKED) {
    test(`${fixture} reports ${expected} in the ranked set`, async () => {
      expect([...(await codesFor(fixture, "ranked"))]).toEqual([expected])
    }, 30_000)
  }
})

describe("a game whose play comes from its parameters' defaults", () => {
  test("is checked under the config a platform serves it", async () => {
    // It ends at its endAt parameter's default, 900. Under an empty config it
    // would never end, and every run would reach the window instead.
    const subject = await loadSubject(join(FIXTURES, "served-config"))
    expect(subject.config).toEqual({ endAt: 900 })
    const report = await validate(subject, { set: "ranked", seeds: ["t1"] })
    expect(report.outcomes.filter((o) => !o.ok).map((o) => o.check)).toEqual([])
    const ends = report.outcomes.find((o) => o.check === "determinism")?.ends
    expect(ends?.map((end) => [end.log, end.endTick, end.terminal])).toEqual([
      ["idle", 900, "completed"],
      ["chaos", 900, "completed"],
      ["bot", 900, "completed"],
    ])
  }, 30_000)

  test("played under another config, it plays that one", async () => {
    const subject = await loadSubject(join(FIXTURES, "served-config"), {
      config: { endAt: 120 },
    })
    const report = await validate(subject, {
      set: "every-game",
      seeds: ["t1"],
      only: ["determinism"],
    })
    expect(report.outcomes[0]?.ends?.map((end) => end.endTick)).toEqual([
      120, 120, 120,
    ])
  }, 30_000)
})

describe("a game whose seed shapes play and whose end does not show it", () => {
  test("passes the seed check, which compares every checkpoint", async () => {
    // The guard that the fixture is the case it claims: under the check's two
    // seeds, every run ends in the same state with the same counters, and
    // some checkpoint before that differs.
    const runs = SENSITIVITY_SEEDS.map((seed) =>
      runSession({
        module: createSeedConverges(),
        seed,
        config: {},
        inputs: new RecordedInputSource([]),
        maxTicks: SENSITIVITY_TICKS,
        checkpointEvery: 60,
      }),
    )
    const [a, b] = runs as [SessionResult, SessionResult]
    expect(a.endTick).toBe(SEED_CONVERGES_ENDS_AT)
    expect(b.checkpoints.at(-1)).toEqual(a.checkpoints.at(-1))
    expect(b.counters).toEqual(a.counters)
    expect(b.checkpoints.length).toBe(a.checkpoints.length)
    expect(
      b.checkpoints.some((c, i) => c.hash !== a.checkpoints[i]?.hash),
    ).toBe(true)

    const subject = await loadSubject(join(FIXTURES, "seed-converges"))
    const report = await validate(subject, { set: "ranked", seeds: ["t1"] })
    expect(report.outcomes.filter((o) => !o.ok).map((o) => o.check)).toEqual([])
    const seedCheck = report.outcomes.find(
      (o) => o.check === "seed-sensitivity",
    )
    expect(seedCheck?.note).toBe("idle differs between seeds")
  }, 30_000)
})

describe("a game that never ends", () => {
  test("passes every check, each run stopped by the check window", async () => {
    // No run has a step limit, so a game that never ends is not refused for
    // it. What the suite owes its reader is where every run stopped.
    const subject = await loadSubject(join(FIXTURES, "endless"))
    const report = await validate(subject, { set: "every-game", seeds: ["t1"] })
    expect(report.outcomes.filter((o) => !o.ok).map((o) => o.check)).toEqual([])
    const ends = report.outcomes.find((o) => o.check === "determinism")?.ends
    expect(ends).toEqual(
      ["idle", "chaos", "bot"].map((log) => ({
        seed: "t1",
        log,
        endTick: CHECK_WINDOW_TICKS,
        terminal: "timeout",
      })),
    )
    expect(formatReport(report)).toContain(
      `t1: idle ran the whole window (${CHECK_WINDOW_TICKS}), chaos ran the whole window (${CHECK_WINDOW_TICKS}), bot ran the whole window (${CHECK_WINDOW_TICKS})`,
    )
  }, 60_000)
})

describe("isolation", () => {
  test("a bundle whose assets do not add up fails only the budgets check", async () => {
    // The game conforms. Only the manifest's account of the bundle does not,
    // and no check that runs a session can see that.
    const subject = await loadSubject(join(FIXTURES, "budget-overrun"))
    const report = await validate(subject, { set: "every-game", seeds: ["t1"] })
    expect(report.outcomes.filter((o) => !o.ok).map((o) => o.check)).toEqual([
      "budgets",
    ])
  }, 30_000)

  test("all four asset faults are reported, not just the first", async () => {
    // A check that stopped at the first bad asset would send someone round the
    // loop once per file.
    const subject = await loadSubject(join(FIXTURES, "budget-overrun"))
    const report = await validate(subject, {
      set: "every-game",
      seeds: ["t1"],
      only: ["budgets"],
    })
    const details = (report.outcomes[0]?.findings ?? []).map((f) => f.detail)
    expect(details).toEqual([
      "data/layout.txt is 38 bytes, the manifest says 99",
      expect.stringContaining("data/texture.txt hashes to"),
      "data/missing.txt is declared but not present",
      "assets total 72 bytes, budget is 1",
    ])
  }, 30_000)

  for (const [fixture, check] of [
    ["seed-ignored", "seed-sensitivity"],
    ["unranked", "ranking"],
  ] as const) {
    test(`${fixture} passes every check a game needs, and fails only ${check} when ranked`, async () => {
      const subject = await loadSubject(join(FIXTURES, fixture))
      const local = await validate(subject, {
        set: "every-game",
        seeds: ["t1"],
      })
      expect(local.ok).toBe(true)
      const ranked = await validate(subject, { set: "ranked", seeds: ["t1"] })
      expect(ranked.outcomes.filter((o) => !o.ok).map((o) => o.check)).toEqual([
        check,
      ])
    }, 30_000)
  }

  test("an incomplete snapshot fails only the restore check", async () => {
    // Nothing else can see it: the game is perfectly deterministic from a
    // cold start, and only restore-then-continue tells them apart.
    const subject = await loadSubject(join(FIXTURES, "incomplete-snapshot"))
    const report = await validate(subject, { set: "every-game", seeds: ["t1"] })
    expect(report.outcomes.filter((o) => !o.ok).map((o) => o.check)).toEqual([
      "restore",
    ])
  }, 30_000)
})

describe("a freshly evaluated module, not a fresh instance", () => {
  test("a module-level counter is reset by load({ fresh: true })", async () => {
    // A fresh instance would keep counting, so the second session would start
    // from different ids and diverge. This is the exact shape that made a
    // fresh instance the wrong unit in the first place.
    const subject = await loadSubject(join(FIXTURES, "module-counter"))
    const a = await subject.load({ fresh: true })
    a.init("s", {}, packReaderFor())
    const b = await subject.load({ fresh: true })
    b.init("s", {}, packReaderFor())
    expect(b.score()).toEqual(a.score())

    // And without it, the counter carries over, which is what the check has
    // to be able to see.
    const c = await subject.load()
    c.init("s", {}, packReaderFor())
    const d = await subject.load()
    d.init("s", {}, packReaderFor())
    expect(d.score()).not.toEqual(c.score())
  })

  test("the determinism check catches a module-level counter", async () => {
    const subject = await loadSubject(join(FIXTURES, "module-counter"))
    const report = await validate(subject, {
      set: "every-game",
      seeds: ["t1"],
      only: ["determinism"],
    })
    // Every run gets its own module evaluation, so a conforming game passes
    // and this one does too; the counter only bites when the module is reused.
    expect(report.outcomes[0]?.check).toBe("determinism")
  }, 30_000)
})

describe("the report", () => {
  test("reads as lines a person can act on", async () => {
    const subject = await loadSubject(join(FIXTURES, "incomplete-snapshot"))
    const report = await validate(subject, {
      set: "every-game",
      seeds: ["t1"],
      only: ["restore"],
    })
    const text = formatReport(report)
    expect(text).toContain("FAIL")
    expect(text).toContain("E_RESTORE_MISMATCH")
    expect(text).toContain("diverged")
  }, 30_000)

  test("says where each seed's run of each log ended", async () => {
    // The conforming fixture ends at tick 1800 whatever is pressed.
    const subject = await loadSubject(join(FIXTURES, "conforming"))
    const report = await validate(subject, {
      set: "every-game",
      seeds: ["t1", "t2"],
      only: ["determinism"],
    })
    const ends = report.outcomes[0]?.ends ?? []
    expect(ends.map((end) => `${end.seed} ${end.log}`)).toEqual([
      "t1 idle",
      "t1 chaos",
      "t1 bot",
      "t2 idle",
      "t2 chaos",
      "t2 bot",
    ])
    for (const end of ends) {
      expect(end.endTick).toBe(1800)
      expect(end.terminal).toBe("completed")
    }
    expect(formatReport(report)).toContain(
      "t2: idle ended at 1800, chaos ended at 1800, bot ended at 1800",
    )
  }, 30_000)

  test("a passing report says so", async () => {
    const subject = await loadSubject(join(FIXTURES, "conforming"))
    const report = await validate(subject, {
      set: "every-game",
      seeds: ["t1"],
      only: ["manifest"],
    })
    expect(formatReport(report)).toContain(
      "all checks in the every-game set passed",
    )
  }, 30_000)
})
