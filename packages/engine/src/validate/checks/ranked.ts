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
  seatsOf,
} from "../../index.js"
import { botInputs, chaosInputs, idleLog } from "../../testing/index.js"
import type { Check, Subject } from "../types.js"
import { configOf, countersOf, sessionPacks } from "./support.js"

/**
 * The two seeds the seed check plays, which no other check uses. They are
 * the seeds vbz's platform played when this check was its own. That check
 * compared only where each run ended, and this one compares every
 * checkpoint as well, so a game it passed passes here too.
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

/**
 * What a run went through and reached, as one string two runs can be compared
 * by: every checkpoint, then the end tick, the terminal and the counters. A
 * checkpoint is a hash of the whole state, so two runs whose strings differ
 * were in different states at some tick, even when they end the same.
 */
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
    seats: seatsOf(subject.manifest),
    ...sessionPacks(subject),
  })
  const counters = Object.keys(result.counters)
    .sort()
    .map((name) => `${name}=${String(result.counters[name])}`)
    .join(",")
  const checkpoints = result.checkpoints
    .map((checkpoint) => `${checkpoint.tick}:${checkpoint.hash}`)
    .join(",")
  return `${checkpoints}|${result.endTick}|${result.terminal}|${counters}`
}

/**
 * Two seeds must pass through different states on the same input log: some
 * checkpoint, the end tick, the terminal or the counters must differ.
 *
 * A game that ignores its seed passes every other check: determinism
 * compares runs of the same seed, so a seed-blind game is perfectly
 * deterministic, restorable and stable across engines. What it is not is a
 * game a platform can serve a seed to. A daily seed would serve the same
 * puzzle every day, and a run's own seed would change nothing. A game whose
 * seed shapes play and whose runs all end alike is not that game, which is
 * why every checkpoint is compared and not only where the run ended.
 */
export const seedSensitivity: Check = {
  name: "seed-sensitivity",
  title: "Two seeds pass through different states on the same input log",
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
          detail: `the ${same.join(", ")} logs passed through the same states under ${a} and ${b}, checkpoint for checkpoint: the seed decides nothing, so every seed a platform serves plays the same game`,
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
