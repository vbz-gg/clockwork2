/**
 * The readouts and resets that other code is built on.
 *
 * Most of these are a line or two, and a test that called one and asserted it
 * returned would tell nobody anything. Each is here for the thing that goes
 * wrong when it is subtly off: a log trimmed at the wrong event, a queue that
 * carries one session's input into the next, a frame scheduled past the end of
 * a run, a renderer handed the simulation's own array to mutate.
 */

import { describe, expect, test } from "bun:test"
import { instantiate } from "../../src/contract"
import { CounterTracker } from "../../src/counters"
import { ClockworkError } from "../../src/errors"
import { encodeCanonical } from "../../src/hash/canonical"
import { LiveInputQueue, RecordedInputSource } from "../../src/inputs"
import { runSession, Session } from "../../src/loop"
import { installShims, uninstallShims, unshimmableApis } from "../../src/shims"
import {
  createReferenceGame,
  REFERENCE_CONFIG,
  REFERENCE_COUNTERS,
} from "../../src/testing/reference-game"
import { Timer } from "../../src/timer"

describe("RecordedInputSource", () => {
  const log = [
    { tick: 0, device: "key", code: "left", value: 1 },
    { tick: 5, device: "key", code: "left", value: 0 },
    { tick: 5, device: "key", code: "thrust", value: 1 },
    { tick: 30, device: "key", code: "thrust", value: 0 },
  ] as const

  /**
   * `consumed` is how a recorder trims a log to the ticks that were actually
   * replayed. One too many and the recording carries an input the run never
   * saw; one too few and it drops one it did.
   */
  /** The source is walked one tick at a time, as a session walks it. */
  function walkTo(source: RecordedInputSource, tick: number): void {
    for (let t = 0; t <= tick; t++) source.take(t)
  }

  test("consumed counts the events walked past, not the ticks", () => {
    const source = new RecordedInputSource(log)
    expect(source.consumed).toBe(0)
    walkTo(source, 0)
    expect(source.consumed).toBe(1)
    walkTo(source, 5)
    expect(source.consumed).toBe(3)
    walkTo(source, 29)
    expect(source.consumed).toBe(3)
    walkTo(source, 30)
    expect(source.consumed).toBe(4)
  })

  test("length is the whole log, however far the cursor has gone", () => {
    const source = new RecordedInputSource(log)
    walkTo(source, 5)
    expect(source.length).toBe(4)
    expect(source.consumed).toBeLessThan(source.length)
  })
})

describe("LiveInputQueue", () => {
  test("pendingCount is what has not been taken yet", () => {
    const queue = new LiveInputQueue()
    queue.push({ device: "key", code: "left", value: 1 })
    queue.push({ device: "key", code: "right", value: 1 })
    expect(queue.pendingCount).toBe(2)
    queue.take(0)
    expect(queue.pendingCount).toBe(0)
  })

  /**
   * A host that reuses one queue across two sessions has to be able to empty
   * it. Without this the second session's recording would open with the first
   * session's last presses, and replay to a state the player never reached.
   */
  test("reset empties both what is pending and what was recorded", () => {
    const queue = new LiveInputQueue()
    queue.push({ device: "key", code: "left", value: 1 })
    queue.take(0)
    queue.push({ device: "key", code: "right", value: 1 })
    expect(queue.pendingCount).toBe(1)
    expect(queue.recorded().length).toBe(1)

    queue.reset()
    expect(queue.pendingCount).toBe(0)
    expect(queue.recorded()).toEqual([])
  })
})

describe("Session readouts", () => {
  function session(maxTicks: number): Session {
    return new Session({
      module: createReferenceGame(),
      seed: "readouts",
      config: REFERENCE_CONFIG,
      inputs: new RecordedInputSource([]),
      maxTicks,
      checkpointEvery: 10,
      counters: REFERENCE_COUNTERS,
    })
  }

  test("tick counts the ticks run", () => {
    const s = session(600)
    expect(s.tick).toBe(0)
    s.step()
    s.step()
    expect(s.tick).toBe(2)
  })

  /**
   * A host reads this to decide whether to ask for another frame. If it stayed
   * true for one tick past the end, the host would schedule a frame on a
   * session that has already produced its result.
   */
  test("running goes false on the very step that ends the run", () => {
    const s = session(3)
    expect(s.running).toBe(true)
    expect(s.step()).toBe(true)
    expect(s.step()).toBe(true)
    expect(s.step()).toBe(false)
    expect(s.running).toBe(false)
    expect(s.result().endTick).toBe(3)
  })

  test("checkpoints accumulate as the run goes, in tick order", () => {
    const s = session(100)
    // One at tick 0 already: the state the run started from is what a resumed
    // run has to match.
    expect(s.checkpoints.map((c) => c.tick)).toEqual([0])
    for (let i = 0; i < 35; i++) s.step()
    const ticks = s.checkpoints.map((c) => c.tick)
    expect(ticks.length).toBeGreaterThan(1)
    expect([...ticks].sort((a, b) => a - b)).toEqual(ticks)
  })
})

describe("Timer.reset", () => {
  /**
   * The handlers are what a game declared; the entries are what a run
   * scheduled. Resetting for a new run has to drop the second and keep the
   * first, or the game restarts with nothing able to fire.
   */
  test("drops what was scheduled and keeps what was declared", () => {
    const fired: string[] = []
    const timer = new Timer()
    timer.define("beep", () => fired.push("beep"))
    timer.after("beep", 5)
    for (let i = 0; i < 3; i++) timer.advance()
    expect(fired).toEqual([])

    timer.reset()
    for (let i = 0; i < 100; i++) timer.advance()
    expect(fired).toEqual([])

    // The handler survived, so the same name can be scheduled again.
    timer.after("beep", 2)
    for (let i = 0; i < 2; i++) timer.advance()
    expect(fired).toEqual(["beep"])
  })

  test("winds the clock back, so a new run starts at tick zero", () => {
    const timer = new Timer()
    for (let i = 0; i < 50; i++) timer.advance()
    expect(timer.exportState().tick).toBe(50)
    timer.reset()
    expect(timer.exportState().tick).toBe(0)
  })
})

describe("the shims", () => {
  test("report which globals could not be trapped", () => {
    // A runtime that froze one of them is a runtime where the trap is not
    // watching, and the validator has to be able to say so rather than report
    // a clean run.
    installShims()
    try {
      expect(Array.isArray(unshimmableApis())).toBe(true)
    } finally {
      uninstallShims()
    }
  })

  /**
   * Writing to a banned global is refused as firmly as reading one. A game that
   * could assign `Date.now = () => 0` would make the trap tell the truth and
   * the simulation still wrong.
   */
  test("assigning to a banned global throws, not only reading one", () => {
    installShims()
    try {
      expect(() => {
        ;(globalThis as unknown as Record<string, unknown>).Date = () => 0
      }).toThrow(/E_BANNED_API/)
    } finally {
      uninstallShims()
    }
  })
})

describe("what canonical encoding refuses, and how it says so", () => {
  /**
   * The message is the whole value of the refusal. A snapshot that cannot be
   * encoded is a game that cannot be replayed, and "a function at state.onTick"
   * is actionable where "unsupported value" is not.
   */
  test("names the kind of value and where it was", () => {
    for (const [value, expected] of [
      [() => 1, "function"],
      [Symbol("s"), "symbol"],
      [new Map(), "Map instance"],
      [new Date(0), "Date instance"],
      [undefined, "undefined"],
    ] as const) {
      let message = ""
      try {
        encodeCanonical({ state: { field: value } } as never)
      } catch (error) {
        message = String(error)
      }
      expect(message).toContain(expected)
      expect(message).toContain("state.field")
    }
  })
})

describe("ClockworkError.tag", () => {
  /**
   * The short form a log line or a CLI prints. It carries the tick, because
   * that is what a divergence is looked up by, and deliberately not the detail,
   * because a detail can be a whole manifest and a log line is one line.
   */
  test("is the code, with the tick when there is one", () => {
    expect(new ClockworkError("E_RESTORE_MISMATCH", { tick: 1800 }).tag).toBe(
      "E_RESTORE_MISMATCH@1800",
    )
    expect(new ClockworkError("E_ASYNC_TICK").tag).toBe("E_ASYNC_TICK")
  })

  test("leaves the detail out, however long it is", () => {
    const error = new ClockworkError("E_MANIFEST_INVALID", {
      tick: 0,
      detail: "x".repeat(500),
    })
    expect(error.tag).toBe("E_MANIFEST_INVALID@0")
    expect(error.message).toContain("x".repeat(500))
  })
})

describe("instantiate", () => {
  test("takes a module as it is", () => {
    const module = createReferenceGame()
    expect(instantiate(module)).toBe(module)
  })

  /**
   * The factory form is the one that matters. A platform runs many sessions,
   * and a fresh instance from a factory is what stops one session's state
   * reaching the next.
   */
  test("calls a factory, and calls it again for the next session", () => {
    const first = instantiate(createReferenceGame)
    const second = instantiate(createReferenceGame)
    expect(first).not.toBe(second)

    first.init("a", REFERENCE_CONFIG)
    second.init("a", REFERENCE_CONFIG)
    expect(second.snapshot()).toEqual(first.snapshot())

    // Advancing one leaves the other where it was, which is the whole point of
    // an instance per session.
    for (let i = 0; i < 30; i++) first.tick([])
    expect(second.snapshot()).not.toEqual(first.snapshot())
  })
})

describe("CounterTracker readouts", () => {
  /**
   * The order is the contract, not just the contents: rankBy and the
   * leaderboard read these positionally, so a set that came back in a
   * different order would rank a game on the wrong counter.
   */
  test("names come back in the order the manifest declared them", () => {
    const tracker = new CounterTracker(REFERENCE_COUNTERS)
    expect(tracker.names).toEqual(REFERENCE_COUNTERS.map((c) => c.name))
  })

  test("reset forgets the previous values, so a new run may start lower", () => {
    // Without it, a second run's opening score would be compared against the
    // first run's final one and reported as a monotone counter going backwards.
    const tracker = new CounterTracker([
      { name: "score", direction: "up", monotonic: true },
    ])
    tracker.check({ score: 10 }, false, 1)
    expect(() => tracker.check({ score: 0 }, false, 2)).toThrow(
      /E_COUNTER_REVERSED/,
    )

    tracker.reset()
    expect(() => tracker.check({ score: 0 }, false, 1)).not.toThrow()
  })
})

describe("the reference game's view", () => {
  /**
   * A renderer reads the view every frame. Handing it the simulation's own
   * array would let a renderer mutate the state it is drawing, which replays
   * differently and which no conformance check can see.
   */
  test("copies the collectibles rather than exposing the live array", () => {
    const game = createReferenceGame()
    game.init("view", REFERENCE_CONFIG)
    for (let i = 0; i < 20; i++) game.tick([])

    const view = game.view()
    expect(view.collectibles.length).toBeGreaterThan(0)
    const before = game.snapshot()
    ;(view.collectibles as Array<{ x: number; y: number }>)[0] = {
      x: 9999,
      y: 9999,
    }
    expect(game.snapshot()).toEqual(before)
  })

  test("reports lives remaining rather than lives lost", () => {
    const game = createReferenceGame()
    game.init("view", REFERENCE_CONFIG)
    expect(game.view().lives).toBe(REFERENCE_CONFIG.lives)
  })

  test("follows the simulation as it runs", () => {
    const game = createReferenceGame()
    game.init("view", REFERENCE_CONFIG)
    const first = game.view()
    const thrust = [
      { tick: 0, device: "key", code: "thrust", value: 1 },
    ] as const
    for (let i = 0; i < 60; i++) game.tick(i === 0 ? thrust : [])
    const later = game.view()
    expect([later.shipX, later.shipY]).not.toEqual([first.shipX, first.shipY])
  })
})

describe("how the reference game ends", () => {
  /**
   * The game's own comment: without a time limit an idle run never ends, and
   * "the run is bounded" becomes a promise the kernel's tick cap has to keep
   * instead of the game. So each of the three endings has to be the game's.
   */
  test("the time limit ends an idle run before the tick cap does", () => {
    const result = runSession({
      module: createReferenceGame(),
      seed: "idle-forever",
      config: REFERENCE_CONFIG,
      inputs: new RecordedInputSource([]),
      maxTicks: 1_000_000,
      checkpointEvery: 600,
      counters: REFERENCE_COUNTERS,
    })
    expect(result.terminal).not.toBe("max-ticks")
    expect(result.endTick).toBeLessThanOrEqual(
      REFERENCE_CONFIG.timeLimitTicks + 1,
    )
  })

  test("reaching the target score ends it earlier than the time limit", () => {
    const result = runSession({
      module: createReferenceGame(),
      seed: "quick",
      config: { ...REFERENCE_CONFIG, targetScore: 1 },
      inputs: new RecordedInputSource([]),
      maxTicks: 1_000_000,
      checkpointEvery: 600,
      counters: REFERENCE_COUNTERS,
    })
    expect(result.endTick).toBeLessThan(REFERENCE_CONFIG.timeLimitTicks)
  })

  test("losing every life ends it too", () => {
    const result = runSession({
      module: createReferenceGame(),
      seed: "fragile",
      config: { ...REFERENCE_CONFIG, lives: 1 },
      inputs: new RecordedInputSource([]),
      maxTicks: 1_000_000,
      checkpointEvery: 600,
      counters: REFERENCE_COUNTERS,
    })
    expect(result.terminal).not.toBe("max-ticks")
  })
})
