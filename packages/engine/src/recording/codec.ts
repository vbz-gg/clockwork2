/**
 * Reading and writing recordings.
 *
 * The wire form is JSON. There is no compression here on purpose: without the
 * per-frame delta array a five-minute recording is a few hundred inputs and a
 * few hundred checkpoints, which is kilobytes, and a transport that wants it
 * smaller can gzip it without the kernel taking on a dependency to do it.
 * game-base pulled in an LZMA library for this and changed codec twice.
 *
 * Decoding checks the format and the version before anything else, so a
 * recording from a kernel that cannot be replayed here says so rather than
 * replaying to a wrong answer.
 */

import type { Counters, InputEvent, PlainValue } from "../contract"
import { TERMINAL_REASONS } from "../contract"
import { fail } from "../errors"
import { validateInputLog } from "../inputs"
import type { Checkpoint } from "../loop"
import { TICK_RATES } from "../manifest/types"
import {
  READABLE_RECORDING_VERSIONS,
  RECORDING_FORMAT,
  type Recording,
} from "./types"

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return false
  }
  const proto = Object.getPrototypeOf(value) as object | null
  return proto === Object.prototype || proto === null
}

export function encodeRecording(recording: Recording): string {
  return JSON.stringify(recording)
}

function malformed(detail: string): never {
  return fail("E_RECORDING_MALFORMED", { detail })
}

/**
 * Parses and checks a recording.
 *
 * @param source JSON text or an already-parsed object
 */
export function decodeRecording(source: string | unknown): Recording {
  let value: unknown = source
  if (typeof source === "string") {
    try {
      value = JSON.parse(source)
    } catch (cause) {
      fail("E_RECORDING_MALFORMED", { detail: "not valid JSON", cause })
    }
  }
  if (!isPlainObject(value)) malformed("must be an object")
  const r = value as Record<string, unknown>

  // Format and version first. Everything below assumes this shape.
  if (r.format !== RECORDING_FORMAT) {
    fail("E_RECORDING_VERSION", {
      detail: `format is ${JSON.stringify(r.format)}, expected ${JSON.stringify(RECORDING_FORMAT)}`,
    })
  }
  if (!READABLE_RECORDING_VERSIONS.includes(r.version as never)) {
    fail("E_RECORDING_VERSION", {
      detail: `version is ${String(r.version)}, this kernel reads ${READABLE_RECORDING_VERSIONS.join(" and ")}`,
    })
  }

  for (const key of [
    "kernelVersion",
    "gameId",
    "gameVersion",
    "manifestHash",
    "seed",
  ]) {
    if (typeof r[key] !== "string" || (r[key] as string).length === 0) {
      malformed(`${key} must be a non-empty string`)
    }
  }
  if (!TICK_RATES.includes(r.tickHz as never)) {
    malformed(`tickHz must be one of ${TICK_RATES.join(", ")}`)
  }
  if (!Number.isInteger(r.endTick) || (r.endTick as number) < 0) {
    malformed("endTick must be a whole number of ticks")
  }
  if (!TERMINAL_REASONS.includes(r.terminal as never)) {
    malformed(`terminal must be one of ${TERMINAL_REASONS.join(", ")}`)
  }
  if (!Array.isArray(r.inputs)) malformed("inputs must be an array")
  if (!Array.isArray(r.checkpoints)) malformed("checkpoints must be an array")
  if (!isPlainObject(r.counters)) malformed("counters must be an object")
  if (r.config === undefined) malformed("config is missing")

  const inputs = r.inputs as readonly InputEvent[]
  validateInputLog(inputs, { endTick: r.endTick as number })

  let previousTick = -1
  for (const checkpoint of r.checkpoints as readonly Checkpoint[]) {
    if (!isPlainObject(checkpoint)) malformed("a checkpoint is not an object")
    if (!Number.isInteger(checkpoint.tick) || checkpoint.tick < 0) {
      malformed(`a checkpoint has tick ${String(checkpoint.tick)}`)
    }
    if (checkpoint.tick < previousTick) {
      malformed(
        `checkpoints go back from ${previousTick} to ${checkpoint.tick}`,
      )
    }
    previousTick = checkpoint.tick
    if (
      typeof checkpoint.hash !== "string" ||
      !/^[0-9a-f]{16}$/.test(checkpoint.hash)
    ) {
      malformed(`a checkpoint hash is ${JSON.stringify(checkpoint.hash)}`)
    }
    if (checkpoint.tick > (r.endTick as number)) {
      malformed(
        `a checkpoint at tick ${checkpoint.tick} is past endTick ${String(r.endTick)}`,
      )
    }
  }

  for (const [name, count] of Object.entries(r.counters as Counters)) {
    if (!Number.isInteger(count) || Math.abs(count) > Number.MAX_SAFE_INTEGER) {
      malformed(`counter ${JSON.stringify(name)} is ${String(count)}`)
    }
  }

  // Absent on a version 1 recording, which is the only reason it is nullable.
  // Present and wrong is a malformed recording: a platform that reads these to
  // tell a slow phone from a cheat cannot do it from a string.
  if (r.hostStats === undefined || r.hostStats === null) {
    return { ...r, hostStats: null } as unknown as Recording
  }
  if (!isPlainObject(r.hostStats)) malformed("hostStats must be an object")
  const stats = r.hostStats as Record<string, unknown>
  for (const key of ["frames", "ticksRun", "mostTicksInAFrame"] as const) {
    const count = stats[key]
    if (!Number.isInteger(count) || (count as number) < 0) {
      malformed(`hostStats.${key} is ${String(count)}`)
    }
  }
  // Not an integer: the accumulator drops a fraction of a millisecond at a
  // time and this is their sum. A stalled tab reports something like
  // 299916.6666666667, which is the measurement rather than a defect in it.
  const dropped = stats.droppedMs
  if (typeof dropped !== "number" || !Number.isFinite(dropped) || dropped < 0) {
    malformed(`hostStats.droppedMs is ${String(dropped)}`)
  }

  return value as Recording
}

/** What a comparison of two runs found. */
export interface RecordingComparison {
  readonly matches: boolean
  /** The first checkpoint whose hash differs, if any. */
  readonly divergedAt: number | null
  readonly differences: readonly string[]
}

/**
 * Compares a replay against what a recording claims.
 *
 * The first differing checkpoint is what makes a divergence investigable: it
 * places the fault in one second of play rather than anywhere in the run.
 */
export function compareToRecording(
  recording: Recording,
  replayed: {
    readonly endTick: number
    readonly counters: Counters
    readonly checkpoints: readonly Checkpoint[]
  },
): RecordingComparison {
  const differences: string[] = []
  let divergedAt: number | null = null

  const claimed = new Map(recording.checkpoints.map((c) => [c.tick, c.hash]))
  const actual = new Map(replayed.checkpoints.map((c) => [c.tick, c.hash]))
  const ticks = [...new Set([...claimed.keys(), ...actual.keys()])].sort(
    (a, b) => a - b,
  )

  for (const tick of ticks) {
    const left = claimed.get(tick)
    const right = actual.get(tick)
    if (left === right) continue
    if (divergedAt === null) divergedAt = tick
    differences.push(
      `tick ${tick}: recorded ${left ?? "(none)"}, replayed ${right ?? "(none)"}`,
    )
  }

  if (recording.endTick !== replayed.endTick) {
    differences.push(
      `endTick: recorded ${recording.endTick}, replayed ${replayed.endTick}`,
    )
  }

  const names = new Set([
    ...Object.keys(recording.counters),
    ...Object.keys(replayed.counters),
  ])
  for (const name of [...names].sort()) {
    const left = recording.counters[name]
    const right = replayed.counters[name]
    if (left !== right) {
      differences.push(
        `${name}: recorded ${String(left)}, replayed ${String(right)}`,
      )
    }
  }

  return { matches: differences.length === 0, divergedAt, differences }
}

/** Compares two snapshots field by field, one level deep, for a readable diff. */
export function diffSnapshots(
  expected: Record<string, PlainValue>,
  actual: Record<string, PlainValue>,
): readonly string[] {
  const differences: string[] = []
  const keys = [
    ...new Set([...Object.keys(expected), ...Object.keys(actual)]),
  ].sort()
  for (const key of keys) {
    if (!(key in expected)) {
      differences.push(`${key}: only in the actual snapshot`)
      continue
    }
    if (!(key in actual)) {
      differences.push(`${key}: missing from the actual snapshot`)
      continue
    }
    const left = JSON.stringify(expected[key])
    const right = JSON.stringify(actual[key])
    if (left !== right)
      differences.push(`${key}: expected ${left}, got ${right}`)
  }
  return differences
}
