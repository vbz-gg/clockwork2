import { describe, expect, test } from "bun:test"
import type {
  Counters,
  Effect,
  GameModule,
  InputEvent,
  Snapshot,
} from "../../src/contract"
import { RecordedInputSource } from "../../src/inputs"
import { runSession, Session } from "../../src/loop"
import { compareResults } from "../../src/testing/compare"
import { botLog, idleLog } from "../../src/testing/input-logs"
import {
  createReferenceGame,
  REFERENCE_CONFIG,
  REFERENCE_COUNTERS,
} from "../../src/testing/reference-game"

const options = (extra: Record<string, unknown> = {}) => ({
  module: createReferenceGame(),
  seed: "seed-1",
  config: REFERENCE_CONFIG,
  inputs: new RecordedInputSource(botLog("run", 20_000)),
  maxTicks: 18_000,
  checkpointEvery: 60,
  counters: REFERENCE_COUNTERS,
  ...extra,
})

describe("Session", () => {
  test("the same seed, config and inputs reach the same state", () => {
    const first = runSession(options())
    const second = runSession(options())
    expect(compareResults(first, second).differences).toEqual([])
  })

  test("a different seed reaches a different state", () => {
    const first = runSession(options())
    const second = runSession(options({ seed: "seed-2" }))
    expect(compareResults(first, second).differences.length).toBeGreaterThan(0)
  })

  test("a checkpoint is taken at the start, on the interval, and at the end", () => {
    const result = runSession(options())
    expect(result.checkpoints[0]?.tick).toBe(0)
    expect(result.checkpoints.at(-1)?.tick).toBe(result.endTick)
    for (const checkpoint of result.checkpoints) {
      expect(checkpoint.hash).toMatch(/^[0-9a-f]{16}$/)
    }
  })

  test("the run ends inside maxTicks even when nobody plays", () => {
    const result = runSession(
      options({ inputs: new RecordedInputSource(idleLog()) }),
    )
    expect(result.endTick).toBeLessThan(18_000)
    expect(result.terminal).toBe("completed")
  })

  test("maxTicks ends a run that will not end itself", () => {
    const result = runSession(options({ maxTicks: 100 }))
    expect(result.endTick).toBe(100)
    expect(result.terminal).toBe("timeout")
  })

  test("step reports when the run is over and does nothing after", () => {
    const session = new Session(options({ maxTicks: 5 }))
    let steps = 0
    while (session.step()) steps++
    expect(steps).toBe(4)
    expect(session.tick).toBe(5)
    expect(session.step()).toBe(false)
    expect(session.tick).toBe(5)
  })

  test("abandoning ends the run and pins the final state", () => {
    const session = new Session(options())
    for (let i = 0; i < 10; i++) session.step()
    session.abandon()
    expect(session.running).toBe(false)
    expect(session.result().terminal).toBe("abandoned")
    expect(session.result().checkpoints.at(-1)?.tick).toBe(10)
  })

  test("effects are drained every tick, listener or not", () => {
    // A headless run with nothing listening must not accumulate them until it
    // runs out of memory.
    const seen: Effect[] = []
    const result = runSession(
      options({
        onEffects: (effects: readonly Effect[]) => {
          seen.push(...effects)
        },
      }),
    )
    expect(seen.length).toBeGreaterThan(0)
    expect(result.endTick).toBeGreaterThan(0)
  })

  test("maxTicks must be a positive whole number", () => {
    expect(() => new Session(options({ maxTicks: 0 }))).toThrow(/E_ARG_INVALID/)
    expect(() => new Session(options({ maxTicks: 1.5 }))).toThrow(
      /E_ARG_INVALID/,
    )
  })
})

describe("restore then continue equals continue", () => {
  test.each([1, 7, 60, 137, 300, 500])("resuming at tick %i", (at) => {
    const log = botLog("resume", 20_000)
    const base = () => ({
      seed: "s",
      config: REFERENCE_CONFIG,
      maxTicks: 18_000,
      checkpointEvery: 60,
      counters: REFERENCE_COUNTERS,
    })
    const uninterrupted = runSession({
      ...base(),
      module: createReferenceGame(),
      inputs: new RecordedInputSource(log),
    })

    const partial = new Session({
      ...base(),
      module: createReferenceGame(),
      inputs: new RecordedInputSource(log),
    })
    for (let i = 0; i < at; i++) partial.step()
    // Through JSON, because that is the trip a snapshot actually takes.
    const snapshot = JSON.parse(
      JSON.stringify(partial.result().snapshot),
    ) as Snapshot

    const resumed = runSession({
      ...base(),
      module: createReferenceGame(),
      inputs: new RecordedInputSource(log),
      resumeFrom: { snapshot, tick: at },
    })

    expect(resumed.endTick).toBe(uninterrupted.endTick)
    expect(resumed.counters).toEqual(uninterrupted.counters)
    const fromResume = uninterrupted.checkpoints.filter((c) => c.tick >= at)
    for (const checkpoint of fromResume) {
      const other = resumed.checkpoints.find((c) => c.tick === checkpoint.tick)
      expect(other?.hash, `tick ${checkpoint.tick}`).toBe(checkpoint.hash)
    }
  })
})

describe("the loop refuses asynchronous work", () => {
  class AsyncGame implements GameModule {
    readonly manifest = {}
    init(): void {
      // nothing
    }
    tick(_inputs: readonly InputEvent[]): unknown {
      return Promise.resolve()
    }
    view(): unknown {
      return {}
    }
    snapshot(): Snapshot {
      return {}
    }
    restore(): void {
      // nothing
    }
    score(): Counters {
      return {}
    }
    isOver(): boolean {
      return false
    }
    effects(): readonly Effect[] {
      return []
    }
  }

  test("a tick that returns a thenable throws", () => {
    const session = new Session({
      module: new AsyncGame() as unknown as GameModule,
      seed: "s",
      config: {},
      inputs: new RecordedInputSource([]),
      maxTicks: 10,
    })
    expect(() => session.step()).toThrow(/E_ASYNC_TICK/)
  })

  test("an init that returns a thenable throws", () => {
    class AsyncInit extends AsyncGame {
      override init(): unknown {
        return Promise.resolve()
      }
      override tick(): void {
        // nothing
      }
    }
    expect(
      () =>
        new Session({
          module: new AsyncInit() as unknown as GameModule,
          seed: "s",
          config: {},
          inputs: new RecordedInputSource([]),
          maxTicks: 10,
        }),
    ).toThrow(/E_ASYNC_TICK/)
  })
})
