/**
 * Seats in the kernel: the manifest field, `seat()` and when it is asked, the
 * seated source a match server trusts, and the feed a page follows.
 *
 * Each test is a way a run of several seats goes wrong: a seat acting on
 * another's turn, a game that never says whose turn it is or names a seat
 * the run does not have, a feed read before its sender confirmed it, and a
 * restore that lands on a turn change.
 */

import { describe, expect, test } from "bun:test"
import { SeatImpureGame } from "../../fixtures/seat-impure/index"
import createSeatMissing from "../../fixtures/seat-missing/index"
import createSeatOutOfRange from "../../fixtures/seat-out-of-range/index"
import {
  checkInputs,
  type ErrorCode,
  hashCanonical,
  type InputEvent,
  type InputSource,
  isClockworkError,
  LiveInputQueue,
  MAX_SEATS,
  RecordedInputSource,
  RemoteInputFeed,
  runSession,
  SeatedInputSource,
  Session,
  type Snapshot,
  seatsOf,
  validateManifest,
} from "../../src"
import {
  createReferenceGame,
  REFERENCE_CONFIG,
  REFERENCE_MANIFEST,
} from "../../src/testing"
import {
  CHECKPOINT_EVERY,
  createTurnsGame,
  MANIFEST,
  playScripted,
  turnChanges,
} from "./match"

/** The code and tick a call threw with, or a failure naming what it did. */
function thrown(body: () => unknown): { code: ErrorCode; tick?: number } {
  try {
    body()
  } catch (error) {
    if (!isClockworkError(error)) throw error
    return {
      code: error.code,
      ...(error.tick === undefined ? {} : { tick: error.tick }),
    }
  }
  throw new Error("expected a ClockworkError, and nothing was thrown")
}

function sessionOptions(inputs: InputSource, seed = "seats") {
  return {
    seed,
    config: {},
    inputs,
    checkpointEvery: CHECKPOINT_EVERY,
    counters: MANIFEST.counters,
    seats: 2,
  }
}

describe("the manifest's seats", () => {
  function issuesFor(seats: unknown): string[] {
    const manifest = {
      ...MANIFEST,
      session: { ...MANIFEST.session, seats },
    }
    return validateManifest(manifest).map((issue) => issue.at)
  }

  test("is a whole number from 1 to 8", () => {
    for (const seats of [1, 2, MAX_SEATS]) expect(issuesFor(seats)).toEqual([])
    for (const seats of [0, MAX_SEATS + 1, 1.5, -2, "2", null]) {
      expect(issuesFor(seats), String(seats)).toEqual(["session.seats"])
    }
  })

  test("left out means one seat, and a one-seat manifest carries no field", () => {
    expect(seatsOf(REFERENCE_MANIFEST)).toBe(1)
    expect(Object.hasOwn(REFERENCE_MANIFEST.session, "seats")).toBe(false)
    expect(seatsOf(MANIFEST)).toBe(2)
  })

  test("is covered by the manifest hash", () => {
    const three = { ...MANIFEST, session: { ...MANIFEST.session, seats: 3 } }
    expect(hashCanonical(three as never)).not.toBe(
      hashCanonical(MANIFEST as never),
    )
  })

  test("leaves capabilities.multiplayer false, which still refuses true", () => {
    const manifest = {
      ...MANIFEST,
      capabilities: { ...MANIFEST.capabilities, multiplayer: true },
    }
    expect(validateManifest(manifest).map((issue) => issue.at)).toEqual([
      "capabilities.multiplayer",
    ])
  })
})

describe("seat()", () => {
  /**
   * A host that asked a different number of times would let a `seat()` with
   * a side effect diverge on one host and not another, which is why the
   * count is pinned to packsNeeded()'s.
   */
  test("is asked exactly when packsNeeded() is: after init, after restore and after every tick", () => {
    const counts = { seat: 0, packs: 0 }
    const counted = () => {
      const game = createTurnsGame()
      const seat = game.seat.bind(game)
      return Object.assign(game, {
        seat: () => {
          counts.seat++
          return seat()
        },
        packsNeeded: () => {
          counts.packs++
          return []
        },
      })
    }
    const session = new Session({
      module: counted(),
      ...sessionOptions(new RecordedInputSource([])),
    })
    for (let i = 0; i < 300; i++) session.step()
    expect(counts).toEqual({ seat: 301, packs: 301 })

    const snapshot = session.result().snapshot
    counts.seat = 0
    counts.packs = 0
    const resumed = new Session({
      module: counted(),
      ...sessionOptions(new RecordedInputSource([])),
      resumeFrom: { snapshot, tick: 300 },
    })
    expect(counts).toEqual({ seat: 1, packs: 1 })
    resumed.step()
    expect(counts).toEqual({ seat: 2, packs: 2 })
  })

  test("names the seat the session hands its source, tick by tick", () => {
    const { players, result } = playScripted("hand-over")
    // Several turns, both seats acting.
    expect(turnChanges(players.seats).length).toBeGreaterThanOrEqual(7)
    expect(new Set(players.seats)).toEqual(new Set([0, 1]))
    expect(players.shares[0]?.length).toBeGreaterThan(5)
    expect(players.shares[1]?.length).toBeGreaterThan(5)
    expect(result.terminal).toBe("completed")

    const session = new Session({
      module: createTurnsGame(),
      ...sessionOptions(new RecordedInputSource(players.merged), "hand-over"),
    })
    do {
      expect(session.seat, `tick ${session.tick}`).toBe(
        players.seats[session.tick] as number,
      )
    } while (session.step())
  })

  test("a one-seat game's source is asked for seat 0, every tick", () => {
    const asked = new Set<number>()
    runSession({
      module: createReferenceGame(),
      seed: "one-seat",
      config: REFERENCE_CONFIG,
      inputs: {
        take: (_tick, seat) => {
          asked.add(seat)
          return []
        },
      },
      maxTicks: 120,
      counters: REFERENCE_MANIFEST.counters,
    })
    expect([...asked]).toEqual([0])
  })

  test("missing on a game with several seats is E_SEAT_INVALID when the session is built", () => {
    let initialised = false
    const game = createSeatMissing()
    const init = game.init.bind(game)
    game.init = (seed) => {
      initialised = true
      init(seed)
    }
    expect(
      thrown(
        () =>
          new Session({
            module: game,
            ...sessionOptions(new RecordedInputSource([])),
          }),
      ),
    ).toEqual({ code: "E_SEAT_INVALID", tick: 0 })
    expect(initialised).toBe(false)
  })

  test("a seat the run does not have is E_SEAT_INVALID at the tick it was named for", () => {
    // The first turn passes when the idle seat runs out of time.
    expect(
      thrown(() =>
        runSession({
          module: createSeatOutOfRange(),
          ...sessionOptions(new RecordedInputSource([])),
          maxTicks: 1000,
        }),
      ),
    ).toEqual({ code: "E_SEAT_INVALID", tick: 180 })

    for (const answer of [-1, 1.5, Number.NaN, "1", null]) {
      const game = Object.assign(createTurnsGame(), {
        seat: () => answer as number,
      })
      expect(
        thrown(
          () =>
            new Session({
              module: game,
              ...sessionOptions(new RecordedInputSource([])),
            }),
        ),
        String(answer),
      ).toEqual({ code: "E_SEAT_INVALID", tick: 0 })
    }
  })

  test("a seat count outside 1 to 8 is E_ARG_INVALID", () => {
    for (const seats of [0, MAX_SEATS + 1, 1.5]) {
      expect(
        thrown(
          () =>
            new Session({
              module: createTurnsGame(),
              ...sessionOptions(new RecordedInputSource([])),
              seats,
            }),
        ).code,
      ).toBe("E_ARG_INVALID")
    }
  })

  test("is asked under the shims, so a banned call in it is refused", () => {
    const game = Object.assign(createTurnsGame(), {
      seat: () => (Math.random() < 2 ? 0 : 1),
    })
    expect(
      thrown(
        () =>
          new Session({
            module: game,
            ...sessionOptions(new RecordedInputSource([])),
          }),
      ).code,
    ).toBe("E_BANNED_API")
  })

  test("a seat() that changes state is what the impure fixture is: two runs agree, an extra call does not", () => {
    // Same call count, same states: the check's extra call is what finds it.
    const once = runSession({
      module: new SeatImpureGame(),
      ...sessionOptions(new RecordedInputSource([])),
      maxTicks: 200,
    })
    const again = runSession({
      module: new SeatImpureGame(),
      ...sessionOptions(new RecordedInputSource([])),
      maxTicks: 200,
    })
    expect(again.checkpoints).toEqual(once.checkpoints)
    const game = new SeatImpureGame()
    game.init("seats")
    const before = hashCanonical(game.snapshot())
    game.seat()
    expect(hashCanonical(game.snapshot())).not.toBe(before)
  })
})

describe("SeatedInputSource", () => {
  test("merges each seat's own log into one that replays through RecordedInputSource to the same checkpoints", () => {
    const { players, result } = playScripted("merge")
    const source = new SeatedInputSource(
      players.shares.map((share) => new RecordedInputSource(share)),
    )
    const seated = runSession({
      module: createTurnsGame(),
      ...sessionOptions(source, "merge"),
      maxTicks: result.endTick,
    })
    expect(seated.checkpoints).toEqual(result.checkpoints)
    expect(source.recorded()).toEqual(players.merged)

    const replayed = runSession({
      module: createTurnsGame(),
      ...sessionOptions(new RecordedInputSource(source.recorded()), "merge"),
      maxTicks: result.endTick,
    })
    expect(replayed.checkpoints).toEqual(result.checkpoints)
    expect(replayed.counters).toEqual(result.counters)
    // Both seats played, over several turns.
    expect(players.shares[0]?.length).toBeGreaterThan(5)
    expect(players.shares[1]?.length).toBeGreaterThan(5)
    expect(result.checkpoints.length).toBeGreaterThan(5)
  })

  test("refuses an input on another seat's turn with E_INPUT_SEAT, at the tick it lands on", () => {
    const { players } = playScripted("off-turn")
    // A tick of seat 0's turn after the first turn change, so seat 1 has
    // already acted once and is now sending out of turn.
    const changes = turnChanges(players.seats)
    const offTurn = (changes[1] as number) + 3
    expect(players.seats[offTurn]).toBe(0)
    const cheat: InputEvent = { tick: offTurn, code: "shoot", value: 1 }
    const share1 = [...(players.shares[1] as InputEvent[]), cheat].sort(
      (a, b) => a.tick - b.tick,
    )
    const source = new SeatedInputSource([
      new RecordedInputSource(players.shares[0] as InputEvent[]),
      new RecordedInputSource(share1),
    ])
    expect(
      thrown(() =>
        runSession({
          module: createTurnsGame(),
          ...sessionOptions(source, "off-turn"),
          maxTicks: 100_000,
        }),
      ),
    ).toEqual({ code: "E_INPUT_SEAT", tick: offTurn })
    // Nothing from the refused tick reached the merged log.
    expect(source.recorded().every((event) => event.tick < offTurn)).toBe(true)
  })

  test("takes one source for each of 1 to 8 seats", () => {
    expect(thrown(() => new SeatedInputSource([])).code).toBe("E_ARG_INVALID")
    const nine = Array.from(
      { length: MAX_SEATS + 1 },
      () => new RecordedInputSource([]),
    )
    expect(thrown(() => new SeatedInputSource(nine)).code).toBe("E_ARG_INVALID")
    const two = new SeatedInputSource([
      new RecordedInputSource([]),
      new RecordedInputSource([]),
    ])
    expect(thrown(() => two.take(0, 2))).toEqual({
      code: "E_ARG_INVALID",
      tick: 0,
    })
  })
})

describe("RemoteInputFeed", () => {
  const feed = () => new RemoteInputFeed(MANIFEST.inputs)

  test("refuses an undeclared input and a value outside its range, as the live queue and checkInputs do", () => {
    for (const [code, value] of [
      ["spin", 1],
      ["aim", 32],
      ["shoot", -1],
    ] as const) {
      const queue = new LiveInputQueue(MANIFEST.inputs)
      const fromQueue = thrown(() => queue.push({ code, value }))
      const fromLog = thrown(() =>
        checkInputs([{ tick: 4, code, value }], MANIFEST.inputs, {
          endTick: 10,
        }),
      )
      const fromFeed = thrown(() => feed().append([{ tick: 4, code, value }]))
      expect(fromQueue.code).toBe("E_INPUT_UNDECLARED")
      expect(fromFeed).toEqual({ code: "E_INPUT_UNDECLARED", tick: 4 })
      expect(fromLog).toEqual(fromFeed)
    }
  })

  test("refuses an unsorted append, within one and across two", () => {
    expect(
      thrown(() =>
        feed().append([
          { tick: 5, code: "shoot", value: 1 },
          { tick: 4, code: "shoot", value: 0 },
        ]),
      ),
    ).toEqual({ code: "E_INPUT_UNSORTED", tick: 4 })
    const twice = feed()
    twice.append([{ tick: 5, code: "shoot", value: 1 }])
    expect(
      thrown(() => twice.append([{ tick: 4, code: "shoot", value: 0 }])),
    ).toEqual({ code: "E_INPUT_UNSORTED", tick: 4 })
  })

  test("refuses an append that reaches back to a confirmed tick", () => {
    const behind = feed()
    behind.confirm(10)
    for (const tick of [10, 3]) {
      expect(
        thrown(() => behind.append([{ tick, code: "aim", value: 1 }])),
      ).toEqual({ code: "E_INPUT_RANGE", tick })
    }
    behind.append([{ tick: 11, code: "aim", value: 1 }])
    behind.confirm(11)
    for (let tick = 0; tick < 11; tick++) expect(behind.take(tick)).toEqual([])
    expect(behind.take(11)).toEqual([{ tick: 11, code: "aim", value: 1 }])
  })

  test("a refused append keeps none of its inputs", () => {
    const partial = feed()
    expect(
      thrown(() =>
        partial.append([
          { tick: 2, code: "aim", value: 3 },
          { tick: 2, code: "spin", value: 1 },
        ]),
      ).code,
    ).toBe("E_INPUT_UNDECLARED")
    partial.confirm(2)
    expect([0, 1, 2].flatMap((tick) => partial.take(tick))).toEqual([])
  })

  test("a tick past the confirmed one is E_INPUT_NOT_CONFIRMED, even with its inputs in hand", () => {
    const early = feed()
    expect(thrown(() => early.take(0))).toEqual({
      code: "E_INPUT_NOT_CONFIRMED",
      tick: 0,
    })
    early.append([{ tick: 1, code: "shoot", value: 1 }])
    early.confirm(0)
    expect(early.confirmedThrough).toBe(0)
    expect(early.take(0)).toEqual([])
    expect(thrown(() => early.take(1))).toEqual({
      code: "E_INPUT_NOT_CONFIRMED",
      tick: 1,
    })
    early.confirm(1)
    expect(early.take(1)).toEqual([{ tick: 1, code: "shoot", value: 1 }])
  })

  test("a confirmation does not go back, and repeating one changes nothing", () => {
    const confirmed = feed()
    confirmed.confirm(5)
    confirmed.confirm(5)
    expect(confirmed.confirmedThrough).toBe(5)
    expect(thrown(() => confirmed.confirm(4)).code).toBe("E_ARG_INVALID")
    expect(thrown(() => confirmed.confirm(6.5)).code).toBe("E_ARG_INVALID")
    expect(confirmed.confirmedThrough).toBe(5)
  })

  test("an input on a tick its reader ran without it is E_INPUT_SEAT at that tick", () => {
    // A page reads its feed only on the other seat's ticks. An input the
    // feed holds for a tick the page ran as its own came from out of turn.
    const skipped = feed()
    skipped.append([
      { tick: 1, code: "aim", value: 2 },
      { tick: 3, code: "shoot", value: 1 },
    ])
    skipped.confirm(5)
    expect(skipped.take(1)).toEqual([{ tick: 1, code: "aim", value: 2 }])
    expect(thrown(() => skipped.take(4))).toEqual({
      code: "E_INPUT_SEAT",
      tick: 3,
    })
  })

  test("seek skips what came before a resumed tick", () => {
    const resumed = feed()
    resumed.append([
      { tick: 1, code: "aim", value: 2 },
      { tick: 6, code: "aim", value: 3 },
    ])
    resumed.confirm(8)
    resumed.seek(5)
    expect(resumed.take(5)).toEqual([])
    expect(resumed.take(6)).toEqual([{ tick: 6, code: "aim", value: 3 }])
  })
})

describe("snapshot and restore mid-match", () => {
  test("at a turn change and mid-turn, a resumed run reaches the state the uninterrupted one did", () => {
    const { players, result } = playScripted("restore")
    const change = turnChanges(players.seats)[2] as number
    const midTurn = change + 20
    expect(players.seats[midTurn]).toBe(players.seats[change])

    for (const at of [change, midTurn]) {
      const partial = new Session({
        module: createTurnsGame(),
        ...sessionOptions(new RecordedInputSource(players.merged), "restore"),
      })
      for (let i = 0; i < at; i++) partial.step()
      expect(partial.seat).toBe(players.seats[at] as number)
      const snapshot = JSON.parse(
        JSON.stringify(partial.result().snapshot),
      ) as Snapshot

      for (const inputs of [
        new RecordedInputSource(players.merged),
        new SeatedInputSource(
          players.shares.map((share) => new RecordedInputSource(share)),
        ),
      ]) {
        const resumed = new Session({
          module: createTurnsGame(),
          ...sessionOptions(inputs, "restore"),
          maxTicks: result.endTick,
          resumeFrom: { snapshot, tick: at },
        })
        // restore() put the turn back: the next tick reads the right seat.
        expect(resumed.seat, `resumed at ${at}`).toBe(
          players.seats[at] as number,
        )
        while (resumed.step()) {
          // to the end
        }
        const ended = resumed.result()
        expect(ended.endTick).toBe(result.endTick)
        expect(ended.counters).toEqual(result.counters)
        for (const checkpoint of result.checkpoints.filter(
          (c) => c.tick > at,
        )) {
          expect(
            ended.checkpoints.find((c) => c.tick === checkpoint.tick)?.hash,
            `resumed at ${at}, tick ${checkpoint.tick}`,
          ).toBe(checkpoint.hash)
        }
      }
    }
  })
})

describe("LiveInputQueue.endTurn", () => {
  test("drops what the helpers release, what is pending and what is carried, and takes nothing until resume", () => {
    const queue = new LiveInputQueue({
      ...MANIFEST.inputs,
      wheel: { min: -2, max: 2 },
    })
    let released = 0
    queue.onPause(() => {
      released++
      queue.push({ code: "shoot", value: 0 })
    })
    queue.push({ code: "shoot", value: 1 })
    queue.push({ code: "wheel", value: 9, merge: "sum" })
    expect(queue.take(0).map((event) => event.value)).toEqual([1, 2])
    queue.push({ code: "aim", value: 4 })

    queue.endTurn()
    expect(released).toBe(1)
    expect(queue.paused).toBe(true)
    queue.push({ code: "aim", value: 5 })
    // Not the release, not the aim, not the 2 the wheel still owed.
    expect(queue.take(1)).toEqual([])

    queue.resume()
    queue.push({ code: "aim", value: 6 })
    expect(queue.take(2)).toEqual([{ tick: 2, code: "aim", value: 6 }])
    expect(queue.recorded().map((event) => event.tick)).toEqual([0, 0, 2])
  })
})
