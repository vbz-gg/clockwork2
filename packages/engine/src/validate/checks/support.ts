/**
 * Pieces the checks share.
 */

import {
  type Checkpoint,
  type CounterDeclaration,
  ERROR_CODES,
  type ErrorCode,
  type GameModule,
  type InputEvent,
  isClockworkError,
  type Manifest,
  RecordedInputSource,
  runSession,
  type SessionResult,
} from "../.."
import { botLog, chaosLog, idleLog } from "../../testing"
import type { Subject } from "../types"

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
    ...(options.shims === undefined ? {} : { shims: options.shims }),
  })
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
