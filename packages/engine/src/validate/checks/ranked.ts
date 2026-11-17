/**
 * The checks a ranked or practice run on a platform needs, and a game played
 * only on its own page does not.
 *
 * A platform serves such a run its seed and its config and ranks what the
 * replay computes, so it needs two things the every-game set cannot ask of a
 * game that is never ranked: that the seed changes what happens, and that the
 * manifest says how one run ranks against another.
 */

import {
  type GameModule,
  type InputEvent,
  RecordedInputSource,
  runSession,
} from "../../index.js"
import { botInputs, chaosInputs, idleLog } from "../../testing/index.js"
import type { Check, Subject } from "../types.js"
import { configOf, countersOf, sessionPacks } from "./support.js"

/**
 * The two seeds the seed check plays, which no other check uses. They are
 * the seeds vbz's platform played when this check was its own, so a game it
 * checked then gets the same answer here.
 */
export const SENSITIVITY_SEEDS = ["vbz-seed-a", "vbz-seed-b"] as const

/** The seed the seed check's logs are generated from, the platform's too. */
const SENSITIVITY_LOG_SEED = "vbz-sensitivity"

/**
 * How far the seed check plays each log: 3,600 ticks, a minute at 60 Hz, as
 * the platform's own check did. It runs six sessions, two seeds over three
 * logs, and stops at the first log whose two runs differ.
 */
export const SENSITIVITY_TICKS = 3_600

/** What a run reached, as one string two runs can be compared by. */
function outcomeOf(
  subject: Subject,
  module: GameModule,
  seed: string,
  inputs: readonly InputEvent[],
): string {
  const result = runSession({
    module,
    seed,
    config: configOf(subject),
    inputs: new RecordedInputSource(inputs),
    maxTicks: SENSITIVITY_TICKS,
    checkpointEvery: subject.manifest.session.tickHz,
    counters: countersOf(subject.manifest),
    ...sessionPacks(subject),
  })
  const counters = Object.keys(result.counters)
    .sort()
    .map((name) => `${name}=${String(result.counters[name])}`)
    .join(",")
  const last = result.checkpoints.at(-1)?.hash ?? "none"
  return `${last}|${result.endTick}|${result.terminal}|${counters}`
}

/**
 * Two seeds must reach different states on the same input log.
 *
 * A game that ignores its seed passes every other check: determinism
 * compares runs of the same seed, so a seed-blind game is perfectly
 * deterministic, restorable and stable across engines. What it is not is a
 * game a platform can serve a seed to. A daily seed would serve the same
 * puzzle every day, and a run's own seed would change nothing.
 */
export const seedSensitivity: Check = {
  name: "seed-sensitivity",
  title: "Two seeds reach different states on the same input log",
  async run({ subject }) {
    const [a, b] = SENSITIVITY_SEEDS
    // Three shapes of play over the game's own inputs, because a game may
    // consult its seed only once the player does something. Each log is built
    // once and played under both seeds, so the seed is the only difference.
    const logs: ReadonlyArray<readonly [string, readonly InputEvent[]]> = [
      ["idle", idleLog()],
      [
        "chaos",
        chaosInputs(subject.manifest, SENSITIVITY_LOG_SEED, SENSITIVITY_TICKS),
      ],
      [
        "bot",
        botInputs(subject.manifest, SENSITIVITY_LOG_SEED, SENSITIVITY_TICKS),
      ],
    ]
    const same: string[] = []
    for (const [name, inputs] of logs) {
      // A fresh module per run, because a module-level counter is exactly
      // the state a seed-blind game leans on without knowing it.
      const left = outcomeOf(
        subject,
        await subject.load({ fresh: true }),
        a,
        inputs,
      )
      const right = outcomeOf(
        subject,
        await subject.load({ fresh: true }),
        b,
        inputs,
      )
      // One differing pair is enough: the claim is that some play makes the
      // seed matter, not that all of it does. A game with a fixed opening
      // and a seeded middle is an ordinary game.
      if (left !== right) {
        return { ok: true, findings: [], note: `${name} differs between seeds` }
      }
      same.push(name)
    }
    return {
      ok: false,
      findings: [
        {
          code: "E_SEED_IGNORED",
          check: "seed-sensitivity",
          detail: `the ${same.join(", ")} logs reached the same state under ${a} and ${b}: the seed decides nothing, so every seed a platform serves plays the same game`,
        },
      ],
    }
  },
}

/**
 * The manifest says how a run ranks. A manifest may leave `rankBy` and
 * `tiePolicy` out, and a game played only on its own page needs neither, but
 * a platform ranking a run has nothing to order it by without them.
 */
export const ranking: Check = {
  name: "ranking",
  title: "The manifest says how a run ranks",
  async run({ subject }) {
    const { rankBy, tiePolicy } = subject.manifest
    if (rankBy === undefined) {
      return {
        ok: false,
        findings: [
          {
            code: "E_RANK_UNDECLARED",
            check: "ranking",
            detail:
              "the manifest declares no rankBy and tiePolicy; a ranked run is ordered by them, so declare both",
          },
        ],
      }
    }
    return {
      ok: true,
      findings: [],
      note: `ranked by ${rankBy.join(", ")}, ties ${tiePolicy}`,
    }
  },
}
