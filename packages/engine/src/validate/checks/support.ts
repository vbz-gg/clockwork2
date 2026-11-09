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
  isClockworkError,
  isStartPack,
  logicPacks,
  type Manifest,
  PackSet,
  RecordedInputSource,
  runSession,
  Session,
  type SessionResult,
  withShims,
} from "../../index.js"
import { botLog, chaosLog, idleLog } from "../../testing/index.js"
import type { Subject } from "../types.js"

export const CHECKPOINT_EVERY = 60

export function countersOf(manifest: Manifest): readonly CounterDeclaration[] {
  return manifest.counters
}

/** The three logs every game is run against. */
export function logsFor(
  manifest: Manifest,
  seed: string,
): ReadonlyMap<string, readonly InputEvent[]> {
  const span = Math.min(manifest.session.maxTicks, 60 * 60 * 10)
  return new Map([
    ["idle", idleLog()],
    ["chaos", chaosLog(seed, span)],
    ["bot", botLog(seed, span)],
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
    config: subject.config ?? {},
    inputs: new RecordedInputSource(options.inputs),
    maxTicks: options.maxTicks ?? subject.manifest.session.maxTicks,
    checkpointEvery: CHECKPOINT_EVERY,
    counters: countersOf(subject.manifest),
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
    config: subject.config ?? {},
    inputs: new RecordedInputSource(options.inputs),
    maxTicks: options.maxTicks ?? subject.manifest.session.maxTicks,
    checkpointEvery: CHECKPOINT_EVERY,
    counters: countersOf(subject.manifest),
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
