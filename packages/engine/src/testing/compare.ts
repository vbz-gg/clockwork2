/**
 * Comparing two runs.
 *
 * Clockwork 1's best statement of its own determinism contract was in its test
 * helpers rather than its source: `StateComparator`, `RecordingValidator` and
 * its checksum. Those ideas are shipped API here, so the conformance suite,
 * the demo and a consumer game all describe a divergence the same way.
 */

import type { Counters, PlainValue, Snapshot } from "../contract.js"
import { encodeCanonical, hashCanonical } from "../hash/canonical.js"
import type { Checkpoint, SessionResult } from "../loop.js"

export interface Divergence {
  /** The first tick where the two runs differ, or null when they do not. */
  readonly tick: number | null
  readonly differences: readonly string[]
}

/** One line per field that differs, one level deep. */
export function compareSnapshots(
  expected: Snapshot,
  actual: Snapshot,
): readonly string[] {
  const differences: string[] = []
  const keys = [
    ...new Set([...Object.keys(expected), ...Object.keys(actual)]),
  ].sort()
  for (const key of keys) {
    if (!(key in expected)) {
      differences.push(`${key}: unexpected key in the actual snapshot`)
      continue
    }
    if (!(key in actual)) {
      differences.push(`${key}: missing from the actual snapshot`)
      continue
    }
    // Canonical, so key order inside a nested object is not reported as a
    // difference when it is not one.
    const left = encodeCanonical(expected[key] as PlainValue)
    const right = encodeCanonical(actual[key] as PlainValue)
    if (left !== right) {
      differences.push(
        `${key}: expected ${JSON.stringify(expected[key])}, got ${JSON.stringify(actual[key])}`,
      )
    }
  }
  return differences
}

/** Finds the first checkpoint where two runs part company. */
export function compareCheckpoints(
  expected: readonly Checkpoint[],
  actual: readonly Checkpoint[],
): Divergence {
  const differences: string[] = []
  let tick: number | null = null
  const byTick = new Map(actual.map((c) => [c.tick, c.hash]))
  for (const checkpoint of expected) {
    const other = byTick.get(checkpoint.tick)
    if (other === checkpoint.hash) continue
    if (tick === null) tick = checkpoint.tick
    differences.push(
      `tick ${checkpoint.tick}: expected ${checkpoint.hash}, got ${other ?? "(no checkpoint)"}`,
    )
  }
  for (const checkpoint of actual) {
    if (!expected.some((c) => c.tick === checkpoint.tick)) {
      differences.push(`tick ${checkpoint.tick}: an extra checkpoint`)
      if (tick === null) tick = checkpoint.tick
    }
  }
  return { tick, differences }
}

export function compareCounters(
  expected: Counters,
  actual: Counters,
): readonly string[] {
  const differences: string[] = []
  const names = [
    ...new Set([...Object.keys(expected), ...Object.keys(actual)]),
  ].sort()
  for (const name of names) {
    if (expected[name] !== actual[name]) {
      differences.push(
        `${name}: expected ${String(expected[name])}, got ${String(actual[name])}`,
      )
    }
  }
  return differences
}

/** Everything two session results can disagree about, in one report. */
export function compareResults(
  expected: SessionResult,
  actual: SessionResult,
): Divergence {
  const checkpoints = compareCheckpoints(
    expected.checkpoints,
    actual.checkpoints,
  )
  const differences = [...checkpoints.differences]
  if (expected.endTick !== actual.endTick) {
    differences.push(
      `endTick: expected ${expected.endTick}, got ${actual.endTick}`,
    )
  }
  if (expected.terminal !== actual.terminal) {
    differences.push(
      `terminal: expected ${expected.terminal}, got ${actual.terminal}`,
    )
  }
  differences.push(...compareCounters(expected.counters, actual.counters))
  if (hashCanonical(expected.snapshot) !== hashCanonical(actual.snapshot)) {
    differences.push(...compareSnapshots(expected.snapshot, actual.snapshot))
  }
  return { tick: checkpoints.tick, differences }
}
