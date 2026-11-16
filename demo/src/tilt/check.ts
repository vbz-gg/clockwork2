/**
 * The tilt check's steps, and how each decides it is done and whether it
 * passed, with nothing here touching the page.
 *
 * Each step asks the person holding the phone for one pose. A step is done
 * when the recorded tilt has held still in roughly that pose for
 * `STILL_MS`, and the pose is judged by what the helper recorded, which is
 * the direction of gravity across the screen times 100: x to the right, y
 * up the screen, z out of it.
 *
 * The test for "done" is deliberately looser than the test for "passed", so
 * a phone whose signs are wrong still finishes the step and the result says
 * what it recorded instead of waiting forever. Upright, for instance, is any
 * pose with gravity mostly across the screen; it passes only when gravity
 * points down the screen.
 */

/** One look at the recorded tilt and the browser's reading behind it. */
export interface Sample {
  /** Milliseconds, from any clock that only goes forward. */
  readonly at: number
  readonly x: number
  readonly y: number
  readonly z: number
  readonly beta: number | null
  readonly gamma: number | null
  readonly alpha: number | null
  /** The screen's angle from the device's natural orientation, if known. */
  readonly angle: number | null
}

/** How long a pose has to hold before a step takes it. */
export const STILL_MS = 1500
/** How far an axis may wander, in recorded units, and still be held still. */
export const STILL_SPREAD = 6
/** How long the page has to be scrolled for the scroll step. */
export const SCROLL_MS = 2500
/** A tilt far enough to read its sign, in recorded units: about 20 degrees. */
export const TILTED = 35

export type StepId = "flat" | "upright" | "steer" | "sideways" | "sidewaysSteer"

export interface Step {
  readonly id: StepId
  readonly instruction: string
  /** What a correct phone records, in words, for the result. */
  readonly expect: string
  /** A phone that cannot turn its screen may skip it. */
  readonly skippable: boolean
  /** Whether a pose held still is the one this step asks for, by any sign. */
  readonly arrived: (pose: Sample, portraitAngle: number | null) => boolean
  readonly passed: (pose: Sample) => boolean
}

const inPlane = (pose: Sample): boolean => Math.abs(pose.z) <= 40
const turned = (pose: Sample, portraitAngle: number | null): boolean =>
  pose.angle !== null && pose.angle !== portraitAngle

export const STEPS: readonly Step[] = [
  {
    id: "flat",
    instruction: "Lay the phone flat on a table, screen up, and let go.",
    expect: "z near -100, x and y near 0",
    skippable: false,
    arrived: (pose) => Math.abs(pose.z) >= 85,
    passed: (pose) =>
      pose.z <= -85 && Math.abs(pose.x) <= 15 && Math.abs(pose.y) <= 15,
  },
  {
    id: "upright",
    instruction:
      "Pick it up and hold it upright in front of you, screen facing you, top edge up. Hold still.",
    expect: "y near -100, x and z near 0",
    skippable: false,
    arrived: (pose) =>
      inPlane(pose) && Math.max(Math.abs(pose.x), Math.abs(pose.y)) >= 80,
    passed: (pose) => pose.y <= -80 && Math.abs(pose.x) <= 20,
  },
  {
    id: "steer",
    instruction:
      "Still upright, turn it like a steering wheel so its right edge goes down, about a third of the way. Hold still.",
    expect: `x above ${TILTED}, y below 0`,
    skippable: false,
    arrived: (pose) => inPlane(pose) && Math.abs(pose.x) >= TILTED,
    passed: (pose) => pose.x >= TILTED && pose.y < 0,
  },
  {
    id: "sideways",
    instruction:
      "Turn the phone on its side and hold it upright, screen facing you, so the picture turns. If it does not turn, unlock screen rotation, or tap Skip.",
    expect: "the screen angle changes, y near -100, x and z near 0",
    skippable: true,
    arrived: (pose, portraitAngle) =>
      turned(pose, portraitAngle) &&
      inPlane(pose) &&
      Math.max(Math.abs(pose.x), Math.abs(pose.y)) >= 80,
    passed: (pose) => pose.y <= -80 && Math.abs(pose.x) <= 20,
  },
  {
    id: "sidewaysSteer",
    instruction:
      "Still on its side, turn it like a steering wheel so the edge on your right goes down. Hold still.",
    expect: `x above ${TILTED}, y below 0`,
    skippable: true,
    arrived: (pose, portraitAngle) =>
      turned(pose, portraitAngle) &&
      inPlane(pose) &&
      Math.abs(pose.x) >= TILTED,
    passed: (pose) => pose.x >= TILTED && pose.y < 0,
  },
]

/**
 * The latest sample, when every sample in the last `STILL_MS` is within
 * `STILL_SPREAD` of it on each axis and the samples reach back that far.
 * Chromium sends a reading only when it changes, so the samples are the
 * recorded values looked at on a timer, not one per reading.
 */
export function heldStill(samples: readonly Sample[]): Sample | null {
  const last = samples[samples.length - 1]
  if (last === undefined) return null
  let reached = false
  for (let i = samples.length - 1; i >= 0; i--) {
    const sample = samples[i] as Sample
    if (last.at - sample.at > STILL_MS) {
      reached = true
      break
    }
    for (const axis of ["x", "y", "z"] as const) {
      if (Math.abs(sample[axis] - last[axis]) > STILL_SPREAD) return null
    }
    if (sample.angle !== last.angle) return null
  }
  return reached ? last : null
}

/** What one step found: the pose it took, or that it was skipped. */
export interface StepResult {
  readonly id: StepId
  readonly expect: string
  readonly outcome: "passed" | "failed" | "skipped"
  readonly pose: Sample | null
}

export function judge(step: Step, pose: Sample | null): StepResult {
  if (pose === null) {
    return { id: step.id, expect: step.expect, outcome: "skipped", pose }
  }
  return {
    id: step.id,
    expect: step.expect,
    outcome: step.passed(pose) ? "passed" : "failed",
    pose,
  }
}

/**
 * Readings a second over a span, in whole seconds, from the times readings
 * arrived. Over the span a page was scrolled, a lowest count of 0 says the
 * browser stopped sending orientation events while it scrolled, which is
 * what the check's last step looks for.
 */
export function readingRate(
  readingTimes: readonly number[],
  from: number,
  to: number,
): { readonly lowest: number; readonly average: number } {
  const seconds = Math.max(1, Math.floor((to - from) / 1000))
  const counts = new Array<number>(seconds).fill(0)
  for (const at of readingTimes) {
    if (at < from || at >= from + seconds * 1000) continue
    const bucket = Math.floor((at - from) / 1000)
    counts[bucket] = (counts[bucket] ?? 0) + 1
  }
  const total = counts.reduce((sum, count) => sum + count, 0)
  return { lowest: Math.min(...counts), average: total / seconds }
}
