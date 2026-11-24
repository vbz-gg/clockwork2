/**
 * Pieces the checks share.
 */

import {
  type AssetDeclaration,
  type Checkpoint,
  type CounterDeclaration,
  ERROR_CODES,
  type ErrorCode,
  type GameModule,
  hashCanonical,
  type InputEvent,
  type InputSource,
  isClockworkError,
  isStartPack,
  logicPacks,
  type Manifest,
  PackSet,
  type PlainValue,
  RecordedInputSource,
  runSession,
  SeatedInputSource,
  Session,
  type SessionResult,
  seatsOf,
  servedConfig,
  withShims,
} from "../../index.js"
import { botInputs, chaosInputs, idleLog } from "../../testing/index.js"
import type { Subject } from "../types.js"

export const CHECKPOINT_EVERY = 60

/**
 * How far the checks play each log: 36,000 ticks, ten minutes at 60 Hz. A
 * run the game has not ended by then stops there, with terminal `timeout`,
 * and the report says where every run ended. Nothing is refused for running
 * the whole window, because no run has a step limit; the window bounds what
 * the suite costs and nothing else.
 */
export const CHECK_WINDOW_TICKS = 36_000

export function countersOf(manifest: Manifest): readonly CounterDeclaration[] {
  return manifest.counters
}

/**
 * The config every session the suite runs is given: the subject's, which
 * `loadSubject` sets to the served config, or the served config for a subject
 * built without one. Never an empty one, which a game with declared defaults
 * would play differently from every session a platform serves.
 */
export function configOf(subject: Subject): PlainValue {
  return (subject.config ?? servedConfig(subject.manifest)) as PlainValue
}

/**
 * The three logs every game is run against, pressing the inputs the game's
 * own manifest declares, as far as the check window.
 */
export function logsFor(
  manifest: Manifest,
  seed: string,
): ReadonlyMap<string, readonly InputEvent[]> {
  return new Map([
    ["idle", idleLog()],
    ["chaos", chaosInputs(manifest, seed, CHECK_WINDOW_TICKS)],
    ["bot", botInputs(manifest, seed, CHECK_WINDOW_TICKS)],
  ])
}

const CHECKED = new WeakMap<Subject, { set: PackSet } | { error: unknown }>()

/**
 * The subject's packs, checked once however many sessions the suite runs.
 *
 * Checking hashes every byte, and the suite runs about seventy sessions of a
 * game. A pack that fails the check fails it here, once, and the same error
 * is rethrown for every session, so each check that runs the game reports the
 * pack's own code rather than the check's.
 */
export function packSetFor(subject: Subject): PackSet {
  let checked = CHECKED.get(subject)
  if (checked === undefined) {
    try {
      checked = {
        set: PackSet.verify(subject.manifest.assets, subject.packs ?? []),
      }
    } catch (error) {
      checked = { error }
    }
    CHECKED.set(subject, checked)
  }
  if ("error" in checked) throw checked.error
  return checked.set
}

/** What every session the suite runs is given about packs. */
export function sessionPacks(subject: Subject): {
  readonly assets: readonly AssetDeclaration[]
  readonly packs: PackSet
} {
  return { assets: subject.manifest.assets ?? [], packs: packSetFor(subject) }
}

export interface RunOptions {
  readonly seed: string
  readonly inputs: readonly InputEvent[]
  readonly maxTicks?: number
  readonly shims?: boolean
  readonly module?: GameModule
}

export async function runOnce(
  subject: Subject,
  options: RunOptions,
): Promise<SessionResult> {
  const module = options.module ?? (await subject.load({ fresh: true }))
  return runSession({
    module,
    seed: options.seed,
    config: configOf(subject),
    inputs: new RecordedInputSource(options.inputs),
    maxTicks: options.maxTicks ?? CHECK_WINDOW_TICKS,
    checkpointEvery: CHECKPOINT_EVERY,
    counters: countersOf(subject.manifest),
    seats: seatsOf(subject.manifest),
    ...sessionPacks(subject),
    ...(options.shims === undefined ? {} : { shims: options.shims }),
  })
}

/**
 * A run in which demand packs are handed over only when the game names them,
 * the way a host that has to download them does, and in which `packsNeeded()`
 * is asked a second time every `CHECKPOINT_EVERY` ticks with the state hashed
 * either side of the call.
 *
 * The kernel makes what a game can read a function of its state, so the
 * result has to equal a run that had every pack from the start. Where it does
 * not, the likeliest cause is a `packsNeeded()` that is not pure, and the
 * hashes say so directly.
 */
export async function runOnDemand(
  subject: Subject,
  options: RunOptions,
): Promise<{ readonly result: SessionResult; readonly impure: number | null }> {
  const module = options.module ?? (await subject.load({ fresh: true }))
  const declared = logicPacks(subject.manifest.assets)
  const given = subject.packs ?? new Map<string, Uint8Array>()
  const start = [...given].filter(([path]) => {
    const asset = declared.get(path)
    return asset !== undefined && isStartPack(asset)
  })
  // A bad pack fails here with its own code. The start packs are then
  // checked again on their own, so that the demand packs really do have to
  // be delivered.
  packSetFor(subject)
  const session = new Session({
    module,
    seed: options.seed,
    config: configOf(subject),
    inputs: new RecordedInputSource(options.inputs),
    maxTicks: options.maxTicks ?? CHECK_WINDOW_TICKS,
    checkpointEvery: CHECKPOINT_EVERY,
    counters: countersOf(subject.manifest),
    seats: seatsOf(subject.manifest),
    assets: subject.manifest.assets ?? [],
    packs: PackSet.verify(subject.manifest.assets, start),
  })
  let impure: number | null = null
  for (;;) {
    for (const path of session.packsMissing()) {
      const bytes = given.get(path)
      if (bytes !== undefined) session.deliver(path, bytes)
    }
    if (impure === null && session.tick % CHECKPOINT_EVERY === 0) {
      const before = hashCanonical(module.snapshot())
      withShims(() => module.packsNeeded?.())
      if (hashCanonical(module.snapshot()) !== before) impure = session.tick
    }
    if (!session.step()) break
  }
  return { result: session.result(), impure }
}

/**
 * A run of a game with `seat()`, played the way a match server plays one:
 * each seat's own inputs through a `SeatedInputSource`.
 *
 * The first pass plays the log as one merged log and splits it by the seat
 * whose turn each tick was, asking `seat()` a second time every
 * `CHECKPOINT_EVERY` ticks with the state hashed either side of the call.
 * The second plays each seat's share from its own source through a seated
 * source, which refuses with `E_INPUT_SEAT` an input on a tick that is not
 * its seat's turn there. Both passes have to reach the same states. When
 * none is refused, the seated source's merged log is the first pass's log
 * by construction, since each share holds only the ticks its seat took.
 */
export async function runSeated(
  subject: Subject,
  options: RunOptions,
): Promise<{
  readonly merged: SessionResult
  readonly seated: SessionResult
  readonly impure: number | null
}> {
  const seats = seatsOf(subject.manifest)
  const module = options.module ?? (await subject.load({ fresh: true }))
  const whole = new RecordedInputSource(options.inputs)
  const shares: InputEvent[][] = Array.from({ length: seats }, () => [])
  const splitting: InputSource = {
    take(tick, seat) {
      const events = whole.take(tick)
      for (const event of events) shares[seat]?.push(event)
      return events
    },
  }
  const session = new Session({
    module,
    seed: options.seed,
    config: configOf(subject),
    inputs: splitting,
    maxTicks: options.maxTicks ?? CHECK_WINDOW_TICKS,
    checkpointEvery: CHECKPOINT_EVERY,
    counters: countersOf(subject.manifest),
    seats,
    ...sessionPacks(subject),
  })
  let impure: number | null = null
  for (;;) {
    if (impure === null && session.tick % CHECKPOINT_EVERY === 0) {
      const before = hashCanonical(module.snapshot())
      withShims(() => module.seat?.())
      if (hashCanonical(module.snapshot()) !== before) impure = session.tick
    }
    if (!session.step()) break
  }
  const merged = session.result()

  const seated = runSession({
    module: await subject.load({ fresh: true }),
    seed: options.seed,
    config: configOf(subject),
    inputs: new SeatedInputSource(
      shares.map((share) => new RecordedInputSource(share)),
    ),
    maxTicks: options.maxTicks ?? CHECK_WINDOW_TICKS,
    checkpointEvery: CHECKPOINT_EVERY,
    counters: countersOf(subject.manifest),
    seats,
    ...sessionPacks(subject),
  })
  return { merged, seated, impure }
}

/**
 * Where two checkpoint lists part company, if they do.
 *
 * Only the ticks in `left` are compared. A resumed run has one extra
 * checkpoint, at the tick it resumed from, and that is not a difference
 * between the two runs - it is the record of where one of them started.
 * Lengths are therefore not compared; a run that ended somewhere else is
 * caught by comparing end ticks, which says so much more plainly.
 */
export function firstDivergence(
  left: readonly Checkpoint[],
  right: readonly Checkpoint[],
): string | null {
  const byTick = new Map(right.map((c) => [c.tick, c.hash]))
  for (const checkpoint of left) {
    const other = byTick.get(checkpoint.tick)
    if (other !== checkpoint.hash) {
      return `tick ${checkpoint.tick}: ${checkpoint.hash} against ${other ?? "(no checkpoint)"}`
    }
  }
  return null
}

/**
 * The error code carried in a thrown error, if it carries one.
 *
 * A run that dies because a runtime trap fired should report the trap, not
 * whichever check happened to be driving. Reporting `E_HEADLESS_THREW` for a
 * game that called `Math.random` would send a developer looking in the wrong
 * place.
 */
export function codeFromError(error: unknown, fallback: ErrorCode): ErrorCode {
  if (isClockworkError(error)) return error.code
  const match = /\b(E_[A-Z_]+)\b/.exec(String(error))
  const found = match?.[1]
  if (found !== undefined && found in ERROR_CODES) return found as ErrorCode
  return fallback
}

/** Runs a session and hands back either the result or the error. */
export async function tryRun(
  subject: Subject,
  options: RunOptions,
): Promise<{ result: SessionResult } | { error: unknown }> {
  try {
    return { result: await runOnce(subject, options) }
  } catch (error) {
    return { error }
  }
}
