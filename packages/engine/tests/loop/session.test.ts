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

/** A game that ends at tick `at`, or never when `at` is null. */
function endsAt(at: number | null): GameModule {
  let ticks = 0
  return {
    manifest: {},
    init() {
      ticks = 0
    },
    tick() {
      ticks++
    },
    view: () => ({ ticks }),
    snapshot: () => ({ ticks }),
    restore: (snapshot: Snapshot) => {
      ticks = snapshot.ticks as number
    },
    score: (): Counters => ({ ticks }),
    isOver: () => at !== null && ticks >= at,
    effects: (): readonly Effect[] => [],
  }
}

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

  test("the reference game ends by itself when nobody plays", () => {
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

  test("maxTicks, when given, must be a positive whole number", () => {
    expect(() => new Session(options({ maxTicks: 0 }))).toThrow(/E_ARG_INVALID/)
    expect(() => new Session(options({ maxTicks: 1.5 }))).toThrow(
      /E_ARG_INVALID/,
    )
  })
})

describe("a session with no maxTicks", () => {
  const unbounded = (module: GameModule) =>
    new Session({
      module,
      seed: "no-limit",
      config: {},
      inputs: new RecordedInputSource([]),
      checkpointEvery: 60,
    })

  test("runs until the game ends it, however long that takes", () => {
    // Past the 36,000 ticks the conformance checks play, which is ten
    // minutes at 60 Hz.
    const session = unbounded(endsAt(40_000))
    while (session.step()) {
      // to the end
    }
    expect(session.result().endTick).toBe(40_000)
    expect(session.result().terminal).toBe("completed")
  })

  test("runs a game that never ends until it is abandoned", () => {
    const session = unbounded(endsAt(null))
    let running = 0
    for (let i = 0; i < 40_000; i++) if (session.step()) running++
    expect(running).toBe(40_000)
    expect(session.running).toBe(true)
    session.abandon()
    expect(session.result().endTick).toBe(40_000)
    expect(session.result().terminal).toBe("abandoned")
    expect(session.result().checkpoints.at(-1)?.tick).toBe(40_000)
  })
})

describe("runSession", () => {
  test("refuses to run without maxTicks, before the game is set up", () => {
    // The type requires it; this is a caller the type did not reach, whose
    // loop would otherwise never return on a game that never ends.
    let initialised = false
    const game = endsAt(null)
    const module: GameModule = {
      ...game,
      init(seed, config, packs) {
        initialised = true
        game.init(seed, config, packs)
      },
    }
    const { maxTicks: _, ...withoutStop } = options({ module })
    expect(() => runSession(withoutStop as never)).toThrow(/E_ARG_INVALID/)
    expect(initialised).toBe(false)
  })

  test("stops at maxTicks with timeout when the game has not ended", () => {
    const result = runSession({
      module: endsAt(null),
      seed: "stop",
      config: {},
      inputs: new RecordedInputSource([]),
      maxTicks: 1234,
    })
    expect(result.endTick).toBe(1234)
    expect(result.terminal).toBe("timeout")
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
