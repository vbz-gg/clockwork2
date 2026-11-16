/**
 * The tilt check's decisions: when a pose has held still, when a step takes
 * it, and whether it passed. The page that wires them up runs in the browser
 * suite; a wrong call here would end a step on a phone still moving, or wait
 * for ever on a phone whose signs are wrong, and only a person holding a
 * phone would notice.
 */

import { describe, expect, test } from "bun:test"
import {
  heldStill,
  judge,
  readingRate,
  type Sample,
  STEPS,
  STILL_MS,
  STILL_SPREAD,
} from "../src/tilt/check"

const pose = (
  x: number,
  y: number,
  z: number,
  angle = 0,
): Omit<Sample, "at"> => ({
  x,
  y,
  z,
  beta: 0,
  gamma: 0,
  alpha: 0,
  angle,
})

/** One sample every 100 ms from 0, all at the given pose. */
const held = (still: Omit<Sample, "at">, ms: number): Sample[] =>
  Array.from({ length: ms / 100 + 1 }, (_, i) => ({ ...still, at: i * 100 }))

const step = (id: string) => {
  const found = STEPS.find((candidate) => candidate.id === id)
  if (found === undefined) throw new Error(`no step ${id}`)
  return found
}

describe("holding still", () => {
  test("a pose is taken once it has held for the whole window, and not before", () => {
    const flat = pose(0, 0, -100)
    expect(heldStill(held(flat, STILL_MS - 100))).toBeNull()
    expect(heldStill(held(flat, STILL_MS + 100))).toMatchObject({ z: -100 })
  })

  test("a wobble inside the spread still counts as still, and one past it does not", () => {
    const samples = held(pose(0, -100, 0), STILL_MS + 100)
    const wobbled = samples.map((sample, i) =>
      i % 2 === 0 ? { ...sample, x: STILL_SPREAD } : sample,
    )
    expect(heldStill(wobbled)).not.toBeNull()
    const moved = [...samples]
    moved[3] = { ...(moved[3] as Sample), x: STILL_SPREAD + 1 }
    expect(heldStill(moved)).toBeNull()
  })

  test("the screen turning during the window is not holding still", () => {
    const samples = held(pose(0, -100, 0, 0), STILL_MS + 100)
    samples[2] = { ...(samples[2] as Sample), angle: 90 }
    expect(heldStill(samples)).toBeNull()
    expect(heldStill([])).toBeNull()
  })
})

describe("the steps", () => {
  test("each pose a correct phone records arrives at its own step and passes it", () => {
    const correct: Record<string, Omit<Sample, "at">> = {
      flat: pose(0, 0, -100),
      upright: pose(0, -100, 0),
      steer: pose(50, -87, 0),
      sideways: pose(0, -100, 0, 90),
      sidewaysSteer: pose(50, -87, 0, 90),
    }
    for (const candidate of STEPS) {
      const sample = { ...(correct[candidate.id] as Omit<Sample, "at">), at: 0 }
      expect(candidate.arrived(sample, 0), candidate.id).toBe(true)
      expect(judge(candidate, sample).outcome, candidate.id).toBe("passed")
    }
  })

  test("the pose one step ends on never ends the next, so no step is taken by the one before", () => {
    const ends = [
      pose(0, 0, -100),
      pose(0, -100, 0),
      pose(50, -87, 0),
      pose(0, -100, 0, 90),
    ]
    for (let i = 0; i < ends.length; i++) {
      const following = STEPS[i + 1]
      if (following === undefined) continue
      const sample = { ...(ends[i] as Omit<Sample, "at">), at: 0 }
      expect(following.arrived(sample, 0), following.id).toBe(false)
    }
  })

  test("a phone with its signs wrong still finishes a step, and fails it", () => {
    // Gravity reported up the screen instead of down, and across the wrong
    // way: the step takes the pose so the result can say what it recorded.
    const upsideDown = { ...pose(0, 100, 0), at: 0 }
    expect(step("upright").arrived(upsideDown, 0)).toBe(true)
    expect(judge(step("upright"), upsideDown).outcome).toBe("failed")
    const sideways = { ...pose(100, 0, 0), at: 0 }
    expect(step("upright").arrived(sideways, 0)).toBe(true)
    expect(judge(step("upright"), sideways).outcome).toBe("failed")
    const steeredLeft = { ...pose(-50, -87, 0), at: 0 }
    expect(step("steer").arrived(steeredLeft, 0)).toBe(true)
    expect(judge(step("steer"), steeredLeft).outcome).toBe("failed")
  })

  test("the sideways steps wait for the screen to turn, and only they may be skipped", () => {
    const unturned = { ...pose(0, -100, 0, 0), at: 0 }
    expect(step("sideways").arrived(unturned, 0)).toBe(false)
    expect(step("sideways").arrived({ ...unturned, angle: null }, 0)).toBe(
      false,
    )
    expect(judge(step("sideways"), null)).toMatchObject({
      outcome: "skipped",
      pose: null,
    })
    expect(STEPS.filter((s) => s.skippable).map((s) => s.id)).toEqual([
      "sideways",
      "sidewaysSteer",
    ])
  })
})

describe("readings a second", () => {
  test("counts each whole second of the span, and finds a second with none", () => {
    const times = [0, 100, 200, 1100, 2900, 3500]
    expect(readingRate(times, 0, 3000)).toEqual({ lowest: 1, average: 5 / 3 })
    expect(readingRate([0, 10, 2500], 0, 3000)).toEqual({
      lowest: 0,
      average: 1,
    })
  })

  test("a span under a second is read as one second", () => {
    expect(readingRate([5, 50], 0, 400)).toEqual({ lowest: 2, average: 2 })
  })
})
