/**
 * Seats in the page host: two pages playing one match over a network, a
 * page that watches it, and a match server between them.
 *
 * Every page runs the whole simulation. On its own seat's turn a page reads
 * its live queue; on another's it holds until its feed confirms the next
 * tick. A manual scheduler per page and a shared clock make the network's
 * delays and stalls something a test states, so none of this waits.
 */

import { describe, expect, test } from "bun:test"
import {
  type Checkpoint,
  type ErrorCode,
  type InputEvent,
  isClockworkError,
  RecordedInputSource,
  RemoteInputFeed,
  runSession,
  Session,
} from "../../src"
import {
  type FrameInfo,
  GameHost,
  ManualScheduler,
  type SeatOptions,
} from "../../src/host/index"
import {
  type FromWorker,
  runSimulationWorker,
} from "../../src/host/worker/index"
import { createReferenceGame, REFERENCE_MANIFEST } from "../../src/testing"
import {
  CHECKPOINT_EVERY,
  Clock,
  createTurnsGame,
  MANIFEST,
  MatchServer,
  PagePlayer,
  seatsOfRun,
  turnChanges,
  Wire,
} from "./match"

const FRAME_MS = 1000 / 60

/** A page's host for one seat, or for watching when `local` is null. */
function page(
  seed: string,
  local: number | null,
  remote: RemoteInputFeed,
  extra: {
    readonly onLocalInputs?: SeatOptions["onLocalInputs"]
    readonly onFrame?: (info: FrameInfo) => void
  } = {},
) {
  const scheduler = new ManualScheduler()
  const errors: unknown[] = []
  const host = new GameHost({
    module: createTurnsGame(),
    manifest: MANIFEST,
    seed,
    scheduler,
    checkpointEvery: CHECKPOINT_EVERY,
    seats: {
      local,
      remote,
      ...(extra.onLocalInputs === undefined
        ? {}
        : { onLocalInputs: extra.onLocalInputs }),
    },
    onError: (error) => {
      errors.push(error)
    },
    ...(extra.onFrame === undefined ? {} : { onFrame: extra.onFrame }),
  })
  return { host, scheduler, errors }
}

type Page = ReturnType<typeof page>

/**
 * Two players, a match server and a spectator, all at 60 frames a second.
 * Each page's inputs go to the other page and to the server; the server
 * relays the merged log to the spectator.
 */
function playMatch(
  seed: string,
  options: {
    readonly delayMs?: number
    /** Holds everything seat 0 sends seat 1 between these two times. */
    readonly stall?: readonly [from: number, until: number]
    readonly eager?: boolean
    /** How many ticks into its turn seat 0 shoots. */
    readonly shootAt?: number
  } = {},
) {
  const clock = new Clock()
  const delay = options.delayMs ?? 50
  const toB = new Wire(clock, new RemoteInputFeed(MANIFEST.inputs), delay)
  const toA = new Wire(clock, new RemoteInputFeed(MANIFEST.inputs), delay)
  const toWatcher = new Wire(clock, new RemoteInputFeed(MANIFEST.inputs), delay)
  const relayed: Array<{
    at: number
    events: readonly InputEvent[]
    through: number
  }> = []
  const server = new MatchServer(seed, (events, through) => {
    relayed.push({ at: clock.now, events, through })
    toWatcher.send(events, through)
  })
  const fromA = new Wire(clock, server.feeds[0] as RemoteInputFeed, delay)
  const fromB = new Wire(clock, server.feeds[1] as RemoteInputFeed, delay)
  const sentBy: InputEvent[][] = [[], []]
  const send =
    (seat: number, peer: Wire, up: Wire) =>
    (events: readonly InputEvent[], through: number) => {
      sentBy[seat]?.push(...events)
      peer.send(events, through)
      up.send(events, through)
    }
  const a = page(seed, 0, toA.feed, { onLocalInputs: send(0, toB, fromA) })
  const b = page(seed, 1, toB.feed, { onLocalInputs: send(1, toA, fromB) })
  const watcher = page(seed, null, toWatcher.feed)
  const players = [
    new PagePlayer(a.host, 0, false, options.shootAt ?? 10),
    new PagePlayer(b.host, 1, options.eager ?? false),
  ]
  const pages = [a, b, watcher]
  for (const each of pages) each.host.start()

  const behind: number[] = []
  for (let frame = 0; frame < 20_000; frame++) {
    if (pages.every((each) => each.host.status === "ended")) break
    if (options.stall !== undefined) {
      const [from, until] = options.stall
      if (clock.now >= from && clock.now < until) toB.stalledUntil = until
    }
    for (const wire of [toA, toB, toWatcher, fromA, fromB]) wire.deliver()
    for (const player of players) {
      if (a.host.status !== "ended" && b.host.status !== "ended") {
        player.beforeFrame()
      }
    }
    for (const each of pages) each.scheduler.advance(FRAME_MS)
    server.pump()
    behind.push(toB.feed.confirmedThrough - (b.host.tick - 1))
    clock.now += FRAME_MS
  }
  return { a, b, watcher, server, sentBy, relayed, behind, clock }
}

function checkpointsOf(each: Page): readonly Checkpoint[] {
  return each.host.result().checkpoints
}

describe("two pages playing one match", () => {
  test("reach the same checkpoints and the same merged log, which replays through RecordedInputSource", () => {
    const match = playMatch("two-pages")
    const { a, b, watcher, server } = match
    for (const each of [a, b, watcher]) {
      expect(each.errors).toEqual([])
      expect(each.host.status).toBe("ended")
    }
    const recording = a.host.recording()
    expect(recording.terminal).toBe("completed")
    expect(checkpointsOf(b)).toEqual(checkpointsOf(a))
    expect(server.session.result().checkpoints).toEqual(checkpointsOf(a))
    expect(b.host.recording().inputs).toEqual(recording.inputs)
    expect(server.source.recorded()).toEqual(recording.inputs)

    // Both seats' inputs are in the one log, over several turns.
    const [sent0, sent1] = match.sentBy as [InputEvent[], InputEvent[]]
    expect(sent0.length).toBeGreaterThan(5)
    expect(sent1.length).toBeGreaterThan(5)
    expect(recording.inputs.length).toBe(sent0.length + sent1.length)
    const seats = seatsOfRun("two-pages", recording.inputs, recording.endTick)
    expect(turnChanges(seats).length).toBeGreaterThanOrEqual(7)
    for (const event of sent0) expect(seats[event.tick]).toBe(0)
    for (const event of sent1) expect(seats[event.tick]).toBe(1)

    const replayed = runSession({
      module: createTurnsGame(),
      seed: recording.seed,
      config: recording.config,
      inputs: new RecordedInputSource(recording.inputs),
      maxTicks: Math.max(recording.endTick, 1),
      checkpointEvery: CHECKPOINT_EVERY,
      counters: MANIFEST.counters,
      seats: 2,
    })
    expect(replayed.checkpoints).toEqual(recording.checkpoints)
    expect(replayed.counters).toEqual(recording.counters)
  })

  test("a spectator reaches the same checkpoints as both players", () => {
    const { a, b, watcher } = playMatch("spectator")
    expect(watcher.host.live).toBeNull()
    expect(watcher.errors).toEqual([])
    expect(checkpointsOf(watcher)).toEqual(checkpointsOf(a))
    expect(checkpointsOf(watcher)).toEqual(checkpointsOf(b))
    expect(watcher.host.recording().inputs).toEqual(a.host.recording().inputs)
    expect(checkpointsOf(a).length).toBeGreaterThanOrEqual(5)
    expect(a.host.result().endTick).toBeGreaterThan(200)
  })

  test("a follower that fell behind at a turn change catches up, and its first input lands at or after the change", () => {
    // Seat 1's page presses on every frame of seat 0's turn too, which its
    // paused queue must not record. Seat 0 takes a second and a half over
    // its first shot, and everything it sends seat 1 in the last second
    // before the turn changes is held, so seat 1 is far behind when its turn
    // comes.
    const calm = playMatch("behind", { shootAt: 90 })
    const seats = seatsOfRun(
      "behind",
      calm.a.host.recording().inputs,
      calm.a.host.recording().endTick,
    )
    const change = turnChanges(seats)[0] as number
    const changeMs = change * FRAME_MS
    expect(changeMs).toBeGreaterThan(1000)
    const stalled = playMatch("behind", {
      eager: true,
      shootAt: 90,
      stall: [changeMs - 1000, changeMs],
    })
    expect(stalled.b.errors).toEqual([])

    // The stall left seat 1 at least 30 ticks behind what seat 0 had sent.
    const released = Math.ceil(changeMs / FRAME_MS)
    const worst = Math.max(...stalled.behind.slice(released, released + 3))
    expect(worst).toBeGreaterThanOrEqual(30)
    // Running only what its clock owed, one tick a frame, it would never
    // gain on the sender. It gains more than two ticks a frame.
    const level = stalled.behind
      .slice(released)
      .findIndex((ticks) => ticks <= 0)
    expect(level).toBeGreaterThan(-1)
    expect(level).toBeLessThan(worst / 2)

    const recording = stalled.b.host.recording()
    const stalledSeats = seatsOfRun(
      "behind",
      recording.inputs,
      recording.endTick,
    )
    const firstChange = turnChanges(stalledSeats)[0] as number
    const first = stalled.sentBy[1]?.[0] as InputEvent
    expect(first.tick).toBeGreaterThanOrEqual(firstChange)
    for (const event of stalled.sentBy[1] as InputEvent[]) {
      expect(stalledSeats[event.tick], `input at ${event.tick}`).toBe(1)
    }
    expect(checkpointsOf(stalled.a)).toEqual(checkpointsOf(stalled.b))
  })
})

describe("a page that joins a match part way", () => {
  test("resumes from a snapshot, skips what its feed holds before it, and reaches the players' states", () => {
    const { a, relayed } = playMatch("rejoin")
    const recording = a.host.recording()
    const at = 100
    const partial = new Session({
      module: createTurnsGame(),
      seed: "rejoin",
      config: {},
      inputs: new RecordedInputSource(recording.inputs),
      counters: MANIFEST.counters,
      seats: 2,
    })
    for (let i = 0; i < at; i++) partial.step()
    const snapshot = partial.result().snapshot
    expect(recording.inputs.some((event) => event.tick < at)).toBe(true)

    // Everything relayed so far arrives at once, from tick 0.
    const feed = new RemoteInputFeed(MANIFEST.inputs)
    for (const message of relayed) {
      feed.append(message.events)
      feed.confirm(message.through)
    }
    const scheduler = new ManualScheduler()
    const rejoined = new GameHost({
      module: createTurnsGame(),
      manifest: MANIFEST,
      seed: "rejoin",
      scheduler,
      checkpointEvery: CHECKPOINT_EVERY,
      seats: { local: null, remote: feed },
      resumeFrom: { snapshot, tick: at },
    })
    rejoined.start()
    while (rejoined.status !== "ended") scheduler.advance(FRAME_MS)
    const later = recording.checkpoints.filter((c) => c.tick > at)
    expect(later.length).toBeGreaterThan(1)
    for (const checkpoint of later) {
      expect(
        rejoined.result().checkpoints.find((c) => c.tick === checkpoint.tick)
          ?.hash,
        `tick ${checkpoint.tick}`,
      ).toBe(checkpoint.hash)
    }
  })
})

describe("a page holding for another seat", () => {
  /**
   * The match is played once, and what the server relayed is played back to
   * a watching page at each frame rate, at the times it was relayed.
   */
  const PACINGS: Array<[label: string, ms: number]> = [
    ["240 Hz", 1000 / 240],
    ["144 Hz", 1000 / 144],
    ["60 Hz", 1000 / 60],
    ["30 Hz", 1000 / 30],
    ["20 Hz", 50],
    ["5 Hz", 200],
  ]

  test("runs no tick past the confirmed one, drops no time, and reaches the same states at 240 to 5 Hz", () => {
    const match = playMatch("pacing")
    const expected = checkpointsOf(match.a)
    for (const [label, ms] of PACINGS) {
      const feed = new RemoteInputFeed(MANIFEST.inputs)
      let ranPast = 0
      let held = 0
      const watcher = page("pacing", null, feed, {
        onFrame: (info) => {
          if (info.tick - 1 > feed.confirmedThrough) ranPast++
          if (info.waitingForSeat !== null) held++
        },
      })
      watcher.host.start()
      let next = 0
      let now = 0
      while (watcher.host.status !== "ended" && now < 600_000) {
        while (
          next < match.relayed.length &&
          (match.relayed[next]?.at as number) <= now
        ) {
          const message = match.relayed[next++] as (typeof match.relayed)[0]
          feed.append(message.events)
          feed.confirm(message.through)
        }
        watcher.scheduler.advance(ms)
        now += ms
      }
      expect(watcher.errors, label).toEqual([])
      expect(ranPast, label).toBe(0)
      expect(held, label).toBeGreaterThan(0)
      expect(checkpointsOf(watcher), label).toEqual(expected)
      // At 5 Hz a frame owes 12 ticks and the catch-up limit runs 5, so the
      // clock drops the rest, as it does for a one-seat game. Waiting for a
      // seat drops nothing at any rate.
      if (ms * 60 <= 5 * 1000) {
        expect(watcher.host.stats.droppedMs, label).toBe(0)
      }
    }
  })

  test("reports the seat it waits for, and never asks the feed for an unconfirmed tick", () => {
    const feed = new RemoteInputFeed(MANIFEST.inputs)
    const frames: FrameInfo[] = []
    const follower = page("waiting", 1, feed, {
      onFrame: (info) => frames.push(info),
    })
    follower.host.start()
    follower.scheduler.run(30, FRAME_MS)
    expect(follower.host.tick).toBe(0)
    expect(follower.host.waitingForSeat).toBe(0)
    expect(frames.every((info) => info.waitingForSeat === 0)).toBe(true)
    expect(follower.host.stats.droppedMs).toBe(0)

    feed.confirm(9)
    follower.scheduler.run(30, FRAME_MS)
    expect(follower.host.tick).toBe(10)
    expect(follower.host.waitingForSeat).toBe(0)
    expect(follower.errors).toEqual([])
    expect(follower.host.stats.droppedMs).toBe(0)
  })
})

describe("a press held across a turn change", () => {
  test("records no input on the other seat's ticks", () => {
    // The page presses shoot on its turn and never lets go. The device
    // helpers release what is held when the queue pauses, which a pause
    // listener stands in for here; at a turn change that release is dropped.
    const clock = new Clock()
    const toB = new Wire(clock, new RemoteInputFeed(MANIFEST.inputs), 0)
    const toA = new Wire(clock, new RemoteInputFeed(MANIFEST.inputs), 0)
    const sent: InputEvent[] = []
    const a = page("held", 0, toA.feed, {
      onLocalInputs: (events, through) => {
        sent.push(...events)
        toB.send(events, through)
      },
    })
    const b = page("held", 1, toB.feed, {
      onLocalInputs: (events, through) => toA.send(events, through),
    })
    const live = a.host.live
    if (live === null) throw new Error("seat 0's page has a live queue")
    let releases = 0
    live.onPause(() => {
      releases++
      live.push({ code: "shoot", value: 0 })
    })
    a.host.start()
    b.host.start()
    let pressed = false
    for (let frame = 0; frame < 2000; frame++) {
      if (a.host.status === "ended") break
      toA.deliver()
      toB.deliver()
      if (!pressed && a.host.seat === 0 && a.host.tick >= 12) {
        pressed = true
        live.push({ code: "aim", value: 20 })
        live.push({ code: "shoot", value: 1 })
      }
      a.scheduler.advance(FRAME_MS)
      b.scheduler.advance(FRAME_MS)
      clock.now += FRAME_MS
    }
    expect(a.errors).toEqual([])
    expect(releases).toBeGreaterThan(0)
    expect(sent).toEqual([
      { tick: sent[0]?.tick as number, code: "aim", value: 20 },
      { tick: sent[0]?.tick as number, code: "shoot", value: 1 },
    ])
    const recording = a.host.recording()
    expect(recording.inputs).toEqual(sent)
    const seats = seatsOfRun("held", recording.inputs, recording.endTick)
    expect(turnChanges(seats).length).toBeGreaterThan(3)
    expect(checkpointsOf(b)).toEqual(checkpointsOf(a))
  })
})

describe("what a host takes for seats", () => {
  function refusal(body: () => unknown): ErrorCode | null {
    try {
      body()
      return null
    } catch (error) {
      return isClockworkError(error) ? error.code : null
    }
  }
  const remote = () => new RemoteInputFeed(MANIFEST.inputs)

  test("a live session of a game with several seats needs them", () => {
    expect(
      refusal(
        () =>
          new GameHost({
            module: createTurnsGame(),
            manifest: MANIFEST,
            seed: "s",
            scheduler: new ManualScheduler(),
          }),
      ),
    ).toBe("E_ARG_INVALID")
  })

  test("a one-seat game and a replay refuse them", () => {
    expect(
      refusal(
        () =>
          new GameHost({
            module: createReferenceGame(),
            manifest: REFERENCE_MANIFEST,
            seed: "s",
            scheduler: new ManualScheduler(),
            seats: { local: 0, remote: remote() },
          }),
      ),
    ).toBe("E_ARG_INVALID")
    expect(
      refusal(
        () =>
          new GameHost({
            module: createTurnsGame(),
            manifest: MANIFEST,
            seed: "s",
            config: {},
            scheduler: new ManualScheduler(),
            inputs: new RecordedInputSource([]),
            seats: { local: 0, remote: remote() },
          }),
      ),
    ).toBe("E_ARG_INVALID")
  })

  test("the local seat is null or one the run has", () => {
    for (const local of [2, -1, 0.5]) {
      expect(
        refusal(
          () =>
            new GameHost({
              module: createTurnsGame(),
              manifest: MANIFEST,
              seed: "s",
              scheduler: new ManualScheduler(),
              seats: { local, remote: remote() },
            }),
        ),
        String(local),
      ).toBe("E_ARG_INVALID")
    }
  })

  test("a replay of a seated run needs no seats: it reads the merged log", () => {
    const { a } = playMatch("replay")
    const recording = a.host.recording()
    const scheduler = new ManualScheduler()
    const replay = new GameHost({
      module: createTurnsGame(),
      manifest: MANIFEST,
      seed: recording.seed,
      config: recording.config,
      inputs: new RecordedInputSource(recording.inputs),
      maxTicks: Math.max(recording.endTick, 1),
      scheduler,
      checkpointEvery: CHECKPOINT_EVERY,
    })
    replay.start()
    while (replay.status !== "ended") scheduler.advance(FRAME_MS)
    expect(replay.result().checkpoints).toEqual(recording.checkpoints)
  })

  test("stepping by hand cannot wait, so an unconfirmed tick of another seat is E_INPUT_NOT_CONFIRMED", () => {
    const sent: Array<[readonly InputEvent[], number]> = []
    const { host } = page("by-hand", 0, remote(), {
      onLocalInputs: (events, through) => sent.push([events, through]),
    })
    host.live?.push({ code: "shoot", value: 1 })
    let steps = 0
    try {
      while (host.stepOnce()) steps++
    } catch (error) {
      expect(isClockworkError(error) && error.code).toBe(
        "E_INPUT_NOT_CONFIRMED",
      )
    }
    // Seat 0's whole turn ran, four ticks of a shot at aim 0, and each step
    // handed its inputs over.
    expect(steps).toBe(4)
    expect(host.seat).toBe(1)
    expect(sent[0]).toEqual([[{ tick: 0, code: "shoot", value: 1 }], 0])
    expect(sent.map(([, through]) => through)).toEqual([0, 1, 2, 3])
  })

  test("the worker host refuses a game with several seats", () => {
    const posted: FromWorker[] = []
    let listener: ((event: { data: unknown }) => void) | null = null
    runSimulationWorker(createTurnsGame, MANIFEST, {
      postMessage: (message) => {
        posted.push(message)
      },
      addEventListener: (_type, added) => {
        listener = added
      },
    })
    ;(listener as unknown as (event: { data: unknown }) => void)({
      data: { type: "init", seed: "s" },
    })
    expect(posted).toEqual([
      expect.objectContaining({ type: "error", code: "E_ARG_INVALID" }),
    ])
  })
})
