/**
 * Packs reaching a session through each host, and the hosts agreeing about
 * the step they reach the game at.
 *
 * The fixture game names its demand pack from tick 300. Each host is given a
 * loader that withholds the pack until the test has watched the host hold for
 * five frames, so the pack really does arrive late; the server replay has it
 * from the start. All three must report that the game first read the pack at
 * tick 300, and must reach the same checkpoints and counters.
 */

import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import createGame, {
  LEVEL,
  LEVEL_FROM,
  MANIFEST,
  type PacksView,
  RULES,
} from "../../fixtures/packs/index"
import {
  ClockworkError,
  type InputEvent,
  type PackBytes,
  PackSet,
  RecordedInputSource,
  runSession,
  type SessionResult,
} from "../../src"
import { GameHost, ManualScheduler } from "../../src/host/index"
import {
  fetchPackLoader,
  loadPack,
  loadPacks,
  memoryPackLoader,
  ownedBuffer,
  type PackLoader,
} from "../../src/host/packs"
import {
  type FromWorker,
  runSimulationWorker,
  WorkerSimulation,
} from "../../src/host/worker/index"

const ROOT = join(import.meta.dir, "../../fixtures/packs")
const BYTES = new Map<string, Uint8Array>(
  [RULES, LEVEL].map((path) => [path, readFileSync(join(ROOT, path))]),
)
const START = new Map([[RULES, BYTES.get(RULES) as Uint8Array]])
const STEP = 1000 / MANIFEST.session.tickHz

/** Inputs the tests make, at ticks either side of the hold and during it. */
const PLAN: readonly InputEvent[] = [
  { tick: 50, device: "key", code: "push", value: 1 },
  { tick: LEVEL_FROM, device: "key", code: "push", value: 1 },
  { tick: 320, device: "key", code: "push", value: 1 },
  { tick: 900, device: "key", code: "push", value: 1 },
]

/** Lets every pending promise chain settle. */
async function settle(): Promise<void> {
  for (let i = 0; i < 20; i++) await Promise.resolve()
}

/** A loader whose answers wait until the test opens the gate. */
function gatedLoader(source: ReadonlyMap<string, PackBytes> = BYTES): {
  loader: PackLoader
  open: () => void
  calls: string[]
} {
  const calls: string[] = []
  let release: () => void = () => {}
  const gate = new Promise<void>((resolve) => {
    release = resolve
  })
  return {
    calls,
    open: () => release(),
    loader: async (path) => {
      calls.push(path)
      await gate
      return memoryPackLoader(source)(path)
    },
  }
}

function serverReplay(inputs: readonly InputEvent[]): {
  result: SessionResult
  openedAt: number
} {
  const game = createGame()
  const result = runSession({
    module: game,
    seed: "packs-hosts",
    config: { prefetch: false },
    inputs: new RecordedInputSource(inputs),
    maxTicks: MANIFEST.session.maxTicks,
    checkpointEvery: MANIFEST.session.tickHz,
    counters: MANIFEST.counters,
    assets: MANIFEST.assets ?? [],
    packs: PackSet.verify(MANIFEST.assets, BYTES),
  })
  return { result, openedAt: game.view().openedAt }
}

describe("a pack arrives at the same step in every host", () => {
  test("the browser host holds, and reaches the replay's state", async () => {
    const scheduler = new ManualScheduler()
    const gated = gatedLoader()
    const frames: Array<{ tick: number; waitingFor: readonly string[] }> = []
    let ended: SessionResult | null = null
    const game = createGame()
    const host = new GameHost<PacksView>({
      module: game,
      manifest: MANIFEST,
      seed: "packs-hosts",
      config: { prefetch: false },
      scheduler,
      packs: { preloaded: START, loader: gated.loader },
      onFrame: (frame) => frames.push(frame),
      onEnded: (result) => {
        ended = result
      },
      onError: (error) => {
        throw error
      },
    })
    host.start()
    const pushed = new Set<number>()
    let heldFrames = 0
    while (ended === null) {
      for (const input of PLAN) {
        if (input.tick === host.tick && !pushed.has(input.tick)) {
          pushed.add(input.tick)
          host.live?.push(input)
        }
      }
      scheduler.advance(STEP)
      await settle()
      if (host.waitingFor.length > 0) {
        heldFrames++
        // Open the gate only once the host has visibly held.
        if (heldFrames === 5) gated.open()
      }
    }

    const held = frames.filter((frame) => frame.waitingFor.length > 0)
    expect(held.length).toBeGreaterThanOrEqual(5)
    expect(new Set(held.map((frame) => frame.tick))).toEqual(
      new Set([LEVEL_FROM]),
    )
    expect(held[0]?.waitingFor).toEqual([LEVEL])
    expect(gated.calls).toEqual([LEVEL])
    expect(host.stats.droppedMs).toBeGreaterThanOrEqual(5 * STEP - 1e-9)

    const recording = host.recording()
    // Guard: the run recorded what the test pressed, at the ticks planned,
    // including the press made while the loop was holding.
    expect(recording.inputs).toEqual(PLAN)
    const replay = serverReplay(recording.inputs)
    expect(game.view().openedAt).toBe(LEVEL_FROM)
    expect(replay.openedAt).toBe(LEVEL_FROM)
    const result = ended as unknown as SessionResult
    expect(result.checkpoints).toEqual(replay.result.checkpoints)
    expect(result.counters).toEqual(replay.result.counters)
    expect(result.endTick).toBe(replay.result.endTick)
  })

  test("the worker host holds, and reaches the replay's state", async () => {
    const pair = new TransferringPair()
    runSimulationWorker(createGame, MANIFEST, pair.scope)
    const gated = gatedLoader()
    const checkpoints: Array<{ tick: number; hash: string }> = []
    let tick = 0
    let view: PacksView | null = null
    let ended: {
      endTick: number
      counters: Record<string, number>
      inputs: readonly InputEvent[]
    } | null = null
    const errors: string[] = []
    const sim = new WorkerSimulation({
      worker: pair.page,
      seed: "packs-hosts",
      config: { prefetch: false },
      packs: { preloaded: START, loader: gated.loader },
      onFrame: (frame) => {
        tick = frame.tick
        view = frame.view as PacksView
      },
      onCheckpoint: (checkpoint) => checkpoints.push(checkpoint),
      onEnded: (result) => {
        ended = result
      },
      onError: (detail) => errors.push(detail),
    })
    // The start pack went over with init, as a copy: the page's own bytes
    // are untouched and the copy it sent is detached.
    expect((START.get(RULES) as Uint8Array).byteLength).toBe(26)
    expect(pair.transferred.length).toBe(1)
    expect(pair.transferred[0]?.byteLength).toBe(0)

    let heldFrames = 0
    const sent = new Set<number>()
    while (ended === null) {
      const due = PLAN.filter(
        (input) => input.tick === tick && !sent.has(input.tick),
      )
      for (const input of due) sent.add(input.tick)
      sim.send(due.map(({ device, code, value }) => ({ device, code, value })))
      const before = tick
      sim.frame(STEP)
      await settle()
      if (tick === before && tick === LEVEL_FROM) {
        heldFrames++
        if (heldFrames === 5) gated.open()
      }
      // Guard against a hold that never ends.
      expect(heldFrames).toBeLessThan(50)
    }
    expect(errors).toEqual([])
    expect(heldFrames).toBeGreaterThanOrEqual(5)
    expect(pair.toPage.filter((m) => m.type === "packs-needed")).toEqual([
      { type: "packs-needed", paths: [LEVEL] },
    ])
    // The level went over as a transferred buffer too.
    expect(pair.transferred.length).toBe(2)
    expect(pair.transferred[1]?.byteLength).toBe(0)

    const finished = ended as unknown as {
      endTick: number
      counters: Record<string, number>
      inputs: readonly InputEvent[]
    }
    // The press sent while holding is stamped at the tick that ran next.
    expect(finished.inputs).toEqual(PLAN)
    const replay = serverReplay(finished.inputs)
    expect((view as unknown as PacksView).openedAt).toBe(LEVEL_FROM)
    expect(checkpoints).toEqual([...replay.result.checkpoints])
    expect(finished.counters).toEqual(replay.result.counters)
    expect(finished.endTick).toBe(replay.result.endTick)
  })

  test("with the prefetch hint and a quick loader, the browser host never holds", async () => {
    const scheduler = new ManualScheduler()
    const calls: string[] = []
    let ended = false
    const host = new GameHost<PacksView>({
      module: createGame(),
      manifest: MANIFEST,
      seed: "packs-hosts",
      scheduler,
      packs: {
        preloaded: START,
        loader: async (path) => {
          calls.push(path)
          return memoryPackLoader(BYTES)(path)
        },
      },
      onEnded: () => {
        ended = true
      },
    })
    host.start()
    let held = 0
    let loadedAt = -1
    while (!ended) {
      scheduler.advance(STEP)
      await settle()
      if (host.waitingFor.length > 0) held++
      if (loadedAt < 0 && calls.length > 0) loadedAt = host.tick
    }
    expect(held).toBe(0)
    expect(calls).toEqual([LEVEL])
    expect(loadedAt).toBeLessThan(LEVEL_FROM)
    expect(host.view().openedAt).toBe(LEVEL_FROM)
    expect(host.stats.droppedMs).toBe(0)
  })
})

/**
 * Like the worker test's pair, but every message goes through
 * `structuredClone` with its transfer list, so a transferred buffer really is
 * detached on the sending side, as it is between a page and a real worker.
 */
class TransferringPair {
  private pageListeners: Array<(event: { data: unknown }) => void> = []
  private scopeListeners: Array<(event: { data: unknown }) => void> = []
  readonly transferred: ArrayBuffer[] = []
  readonly toPage: FromWorker[] = []

  readonly page = {
    postMessage: (message: unknown, transfer: Transferable[] = []): void => {
      this.transferred.push(...(transfer as ArrayBuffer[]))
      const data = structuredClone(message, { transfer })
      for (const listener of [...this.scopeListeners]) listener({ data })
    },
    addEventListener: (
      _type: string,
      listener: (event: { data: unknown }) => void,
    ): void => {
      this.pageListeners.push(listener)
    },
    terminate: (): void => {},
  } as unknown as Worker

  readonly scope = {
    postMessage: (message: FromWorker): void => {
      this.toPage.push(message)
      const data = structuredClone(message)
      for (const listener of [...this.pageListeners]) listener({ data })
    },
    addEventListener: (
      _type: "message",
      listener: (event: { data: unknown }) => void,
    ): void => {
      this.scopeListeners.push(listener)
    },
  }
}

function newHost(
  packs: ConstructorParameters<typeof GameHost>[0]["packs"],
  errors: unknown[] = [],
  extra: { prefetch?: boolean } = {},
): { host: GameHost<PacksView>; scheduler: ManualScheduler } {
  const scheduler = new ManualScheduler()
  const host = new GameHost<PacksView>({
    module: createGame(),
    manifest: MANIFEST,
    seed: "packs-hosts",
    config: { prefetch: extra.prefetch ?? false },
    scheduler,
    ...(packs === undefined ? {} : { packs }),
    onError: (error) => errors.push(error),
  })
  return { host, scheduler }
}

async function runTo(
  host: GameHost<PacksView>,
  scheduler: ManualScheduler,
  tick: number,
): Promise<void> {
  host.start()
  for (let i = 0; i < tick + 200 && host.status === "running"; i++) {
    if (host.tick >= tick) break
    scheduler.advance(STEP)
    await settle()
  }
}

function codes(errors: readonly unknown[]): string[] {
  return errors.map((error) =>
    error instanceof ClockworkError ? error.code : String(error),
  )
}

describe("the browser host's pack rules", () => {
  test("a start pack that was not preloaded fails construction", () => {
    let caught: unknown
    try {
      newHost({ loader: memoryPackLoader(BYTES) })
    } catch (error) {
      caught = error
    }
    expect((caught as ClockworkError).code).toBe("E_PACK_NOT_DELIVERED")
  })

  test("a needed pack with no loader ends the run at once rather than holding", async () => {
    const errors: unknown[] = []
    const { host, scheduler } = newHost({ preloaded: START }, errors)
    await runTo(host, scheduler, LEVEL_FROM + 5)
    expect(codes(errors)).toEqual(["E_PACK_NOT_DELIVERED"])
    expect(host.status).toBe("ended")
    expect(host.tick).toBe(LEVEL_FROM)
  })

  test("a needed load that fails ends the run with the loader's reason", async () => {
    const errors: unknown[] = []
    const { host, scheduler } = newHost(
      {
        preloaded: START,
        loader: async () => {
          throw new TypeError("network down")
        },
      },
      errors,
    )
    await runTo(host, scheduler, LEVEL_FROM + 5)
    expect(codes(errors)).toEqual(["E_PACK_NOT_DELIVERED"])
    expect(String((errors[0] as ClockworkError).detail)).toContain(
      "network down",
    )
  })

  test("bad bytes for a needed pack end the run with the kernel's code", async () => {
    const errors: unknown[] = []
    const { host, scheduler } = newHost(
      { preloaded: START, loader: async () => new Uint8Array(28) },
      errors,
    )
    await runTo(host, scheduler, LEVEL_FROM + 5)
    expect(codes(errors)).toEqual(["E_PACK_HASH_MISMATCH"])
  })

  test("a failed prefetch is forgotten, and the pack is fetched again when needed", async () => {
    const errors: unknown[] = []
    let calls = 0
    const { host, scheduler } = newHost(
      {
        preloaded: START,
        // The first call throws synchronously, inside the step that raised
        // the hint; the second works.
        loader: (path) => {
          calls++
          if (calls === 1) throw new Error("flaky")
          return memoryPackLoader(BYTES)(path)
        },
      },
      errors,
      { prefetch: true },
    )
    await runTo(host, scheduler, LEVEL_FROM + 10)
    expect(errors).toEqual([])
    expect(calls).toBe(2)
    expect(host.view().openedAt).toBe(LEVEL_FROM)
  })

  test("bad bytes from a prefetch are forgotten too", async () => {
    const errors: unknown[] = []
    let calls = 0
    const { host, scheduler } = newHost(
      {
        preloaded: START,
        loader: async (path) => {
          calls++
          return calls === 1
            ? new Uint8Array(1)
            : (BYTES.get(path) as Uint8Array)
        },
      },
      errors,
      { prefetch: true },
    )
    await runTo(host, scheduler, LEVEL_FROM + 10)
    expect(errors).toEqual([])
    expect(calls).toBe(2)
  })

  test("a load that settles after the run stopped reports nothing", async () => {
    const errors: unknown[] = []
    const gated = gatedLoader()
    const { host, scheduler } = newHost(
      { preloaded: START, loader: gated.loader },
      errors,
    )
    await runTo(host, scheduler, LEVEL_FROM)
    scheduler.advance(STEP)
    expect(host.waitingFor).toEqual([LEVEL])
    host.stop()
    gated.open()
    await settle()
    expect(errors).toEqual([])
    expect(host.status).toBe("ended")
    // And a host that is destroyed while a hint is in flight ignores it too.
    const late = gatedLoader()
    const second = newHost({ preloaded: START, loader: late.loader }, errors, {
      prefetch: true,
    })
    await runTo(second.host, second.scheduler, 245)
    second.host.destroy()
    late.open()
    await settle()
    expect(errors).toEqual([])
  })

  test("a needed pack already being prefetched is not fetched twice", async () => {
    const errors: unknown[] = []
    const gated = gatedLoader()
    const { host, scheduler } = newHost(
      { preloaded: START, loader: gated.loader },
      errors,
      { prefetch: true },
    )
    await runTo(host, scheduler, LEVEL_FROM)
    for (let i = 0; i < 3; i++) {
      scheduler.advance(STEP)
      await settle()
    }
    expect(host.waitingFor).toEqual([LEVEL])
    expect(gated.calls).toEqual([LEVEL])
    gated.open()
    await settle()
    scheduler.advance(STEP)
    expect(host.tick).toBe(LEVEL_FROM + 1)
    expect(errors).toEqual([])
  })

  test("a hold that starts part-way through a frame runs no further steps", async () => {
    // Five ticks a frame, so the frame that reaches 300 stops there.
    const scheduler = new ManualScheduler()
    const gated = gatedLoader()
    const host = new GameHost<PacksView>({
      module: createGame(),
      manifest: MANIFEST,
      seed: "packs-hosts",
      config: { prefetch: false },
      scheduler,
      packs: { preloaded: START, loader: gated.loader },
    })
    host.start()
    // One tick, then frames long enough to hit the catch-up limit, which
    // runs five steps and drops the rest of the time each frame: 1, 6, ...,
    // 296. The frame from 296 runs four steps and stops at 300 instead of
    // running its fifth.
    scheduler.advance(STEP)
    while (gated.calls.length === 0) {
      scheduler.advance(STEP * 7)
      await settle()
    }
    expect(host.tick).toBe(LEVEL_FROM)
    expect(gated.calls).toEqual([LEVEL])
    // The steps the frame did not run count as held time.
    expect(host.stats.droppedMs).toBeGreaterThan(0)
    gated.open()
    await settle()
    scheduler.advance(STEP)
    expect(host.tick).toBe(LEVEL_FROM + 1)
  })

  test("with no loader, a hold that starts part-way through a frame ends the run", async () => {
    const errors: unknown[] = []
    const scheduler = new ManualScheduler()
    const host = new GameHost<PacksView>({
      module: createGame(),
      manifest: MANIFEST,
      seed: "packs-hosts",
      config: { prefetch: false },
      scheduler,
      packs: { preloaded: START },
      onError: (error) => errors.push(error),
    })
    host.start()
    scheduler.advance(STEP)
    for (let i = 0; i < 100 && host.status === "running"; i++) {
      scheduler.advance(STEP * 7)
    }
    expect(codes(errors)).toEqual(["E_PACK_NOT_DELIVERED"])
    expect(host.tick).toBe(LEVEL_FROM)
  })

  test("a game that names an undeclared pack ends the run with that code", () => {
    // The same game under a manifest that leaves its level out.
    const errors: unknown[] = []
    const scheduler = new ManualScheduler()
    const host = new GameHost<PacksView>({
      module: createGame(),
      manifest: {
        ...MANIFEST,
        assets: (MANIFEST.assets ?? []).filter((a) => a.path !== LEVEL),
      },
      seed: "packs-hosts",
      config: { prefetch: false },
      scheduler,
      packs: { preloaded: START },
      onError: (error) => errors.push(error),
    })
    host.start()
    for (let i = 0; i < 400 && host.status === "running"; i++) {
      scheduler.advance(STEP)
    }
    expect(codes(errors)).toEqual(["E_PACK_UNDECLARED"])
    expect(host.status).toBe("ended")
  })

  test("stepping by hand into a missing pack throws the kernel's code", () => {
    const { host } = newHost({ preloaded: START })
    let caught: unknown
    try {
      while (host.stepOnce()) {}
    } catch (error) {
      caught = error
    }
    expect((caught as ClockworkError).code).toBe("E_PACK_NOT_DELIVERED")
    expect(host.tick).toBe(LEVEL_FROM)
  })
})

describe("the worker host's pack rules", () => {
  function worker(
    loader: PackLoader | undefined,
    onError: (detail: string, code?: string) => void,
  ): { sim: WorkerSimulation; pair: TransferringPair; tick: () => number } {
    const pair = new TransferringPair()
    runSimulationWorker(createGame, MANIFEST, pair.scope)
    let tick = 0
    const sim = new WorkerSimulation({
      worker: pair.page,
      seed: "packs-hosts",
      config: { prefetch: false },
      packs: {
        preloaded: START,
        ...(loader === undefined ? {} : { loader }),
      },
      onFrame: (frame) => {
        tick = frame.tick
      },
      onError,
    })
    return { sim, pair, tick: () => tick }
  }

  test("bad bytes are refused in the worker, reported with the code, and end the run", async () => {
    const errors: Array<[string, string | undefined]> = []
    const { sim, pair, tick } = worker(
      async () => new Uint8Array(28),
      (detail, code) => errors.push([detail, code]),
    )
    for (let i = 0; i < LEVEL_FROM + 20; i++) {
      sim.frame(STEP)
      await settle()
    }
    expect(errors.map(([, code]) => code)).toEqual(["E_PACK_HASH_MISMATCH"])
    // Nothing runs after the failure.
    const stopped = tick()
    sim.frame(STEP)
    expect(tick()).toBe(stopped)
    expect(pair.toPage.filter((m) => m.type === "error").length).toBe(1)
  })

  test("a needed load that fails on the page is reported with the code", async () => {
    const errors: Array<string | undefined> = []
    const { sim } = worker(undefined, (_detail, code) => errors.push(code))
    for (let i = 0; i < LEVEL_FROM + 5; i++) {
      sim.frame(STEP)
      await settle()
    }
    expect(errors).toEqual(["E_PACK_NOT_DELIVERED"])
  })

  test("a start pack missing from init is refused in the worker", () => {
    const pair = new TransferringPair()
    runSimulationWorker(createGame, MANIFEST, pair.scope)
    const errors: Array<string | undefined> = []
    new WorkerSimulation({
      worker: pair.page,
      seed: "x",
      onError: (_detail, code) => errors.push(code),
    })
    expect(errors).toEqual(["E_PACK_NOT_DELIVERED"])
  })

  test("prefetch hints in the worker reach the page's loader", async () => {
    const pair = new TransferringPair()
    runSimulationWorker(createGame, MANIFEST, pair.scope)
    const calls: string[] = []
    let tick = 0
    const sim = new WorkerSimulation({
      worker: pair.page,
      seed: "x",
      config: {},
      packs: {
        preloaded: START,
        loader: async (path) => {
          calls.push(path)
          return BYTES.get(path) as Uint8Array
        },
      },
      onFrame: (frame) => {
        tick = frame.tick
      },
    })
    for (let i = 0; i < LEVEL_FROM + 5; i++) {
      sim.frame(STEP)
      await settle()
    }
    expect(calls).toEqual([LEVEL])
    expect(tick).toBe(LEVEL_FROM + 5)
    expect(pair.toPage.some((m) => m.type === "packs-needed")).toBe(false)
    sim.stop()
    sim.terminate()
  })
})

describe("loaders", () => {
  function response(
    body: Uint8Array | null,
    init: {
      status?: number
      headers?: Record<string, string>
      failAt?: number
    } = {},
  ): Response {
    if (body === null) return new Response(null, { status: init.status ?? 200 })
    let sent = 0
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (init.failAt !== undefined && sent >= init.failAt) {
          controller.error(new Error("connection reset"))
          return
        }
        if (sent >= body.length) {
          controller.close()
          return
        }
        const chunk = body.subarray(sent, sent + 8)
        sent += chunk.length
        controller.enqueue(chunk)
      },
    })
    return new Response(stream, {
      status: init.status ?? 200,
      ...(init.headers === undefined ? {} : { headers: init.headers }),
    })
  }

  function loaderFor(
    answer: (url: string, init: RequestInit) => Promise<Response>,
    signal?: AbortSignal,
  ): PackLoader {
    return fetchPackLoader({
      manifest: MANIFEST,
      url: (pack) => `/pack/${pack.sha256}`,
      fetch: answer,
      ...(signal === undefined ? {} : { signal }),
    })
  }

  async function codeOf(work: Promise<unknown>): Promise<string> {
    try {
      await work
    } catch (error) {
      return error instanceof ClockworkError ? error.code : String(error)
    }
    return "no error"
  }

  test("fetch asks for the pack by fingerprint, with no credentials", async () => {
    const seen: Array<[string, RequestInit]> = []
    const controller = new AbortController()
    const load = loaderFor(async (url, init) => {
      seen.push([url, init])
      return response(BYTES.get(LEVEL) as Uint8Array)
    }, controller.signal)
    const bytes = await load(LEVEL)
    expect([...(bytes as Uint8Array)]).toEqual([
      ...(BYTES.get(LEVEL) as Uint8Array),
    ])
    const [url, init] = seen[0] as [string, RequestInit]
    expect(url).toBe(`/pack/${(MANIFEST.assets ?? [])[1]?.sha256}`)
    expect(init.mode).toBe("cors")
    expect(init.credentials).toBe("omit")
    expect(init.signal).toBe(controller.signal)
  })

  test("a body larger than declared is cut off, and a large Content-Length is not", async () => {
    const level = BYTES.get(LEVEL) as Uint8Array
    const longer = new Uint8Array(level.length + 40)
    expect(await codeOf(loaderFor(async () => response(longer))(LEVEL))).toBe(
      "E_PACK_TOO_LARGE",
    )
    // A gzip-encoded length can exceed the decoded size; only the bytes count.
    const bytes = await loaderFor(async () =>
      response(level, { headers: { "content-length": "4096" } }),
    )(LEVEL)
    expect((bytes as Uint8Array).byteLength).toBe(level.byteLength)
  })

  test("refusals, network failures and broken bodies are not delivered", async () => {
    expect(
      await codeOf(
        loaderFor(async () => response(new Uint8Array(0), { status: 404 }))(
          LEVEL,
        ),
      ),
    ).toBe("E_PACK_NOT_DELIVERED")
    expect(
      await codeOf(
        loaderFor(async () => {
          throw new TypeError("Failed to fetch")
        })(LEVEL),
      ),
    ).toBe("E_PACK_NOT_DELIVERED")
    expect(
      await codeOf(
        loaderFor(async () =>
          response(BYTES.get(LEVEL) as Uint8Array, { failAt: 8 }),
        )(LEVEL),
      ),
    ).toBe("E_PACK_NOT_DELIVERED")
    expect(await codeOf(loaderFor(async () => response(null))(LEVEL))).toBe(
      "no error",
    )
    expect(
      await codeOf(loaderFor(async () => response(null))("data/secret.json")),
    ).toBe("E_PACK_UNDECLARED")
  })

  test("the default fetch is the global one", async () => {
    const saved = globalThis.fetch
    const urls: string[] = []
    globalThis.fetch = (async (input: string) => {
      urls.push(input)
      return response(BYTES.get(RULES) as Uint8Array)
    }) as typeof fetch
    try {
      const load = fetchPackLoader({
        manifest: MANIFEST,
        url: (pack) => pack.path,
      })
      await load(RULES)
    } finally {
      globalThis.fetch = saved
    }
    expect(urls).toEqual([RULES])
  })

  test("loadPacks fetches the start packs, or all of them", async () => {
    const memory = memoryPackLoader(BYTES)
    expect([...(await loadPacks(MANIFEST, memory)).keys()]).toEqual([RULES])
    expect([...(await loadPacks(MANIFEST, memory, "all")).keys()]).toEqual([
      RULES,
      LEVEL,
    ])
    expect(await codeOf(memory("data/secret.json"))).toBe(
      "E_PACK_NOT_DELIVERED",
    )
  })

  test("loadPack turns a throw into a rejection, after the current step", async () => {
    let called = false
    const pending = loadPack(() => {
      called = true
      throw new Error("sync")
    }, LEVEL)
    // Not called yet: the call waits for a microtask.
    expect(called).toBe(false)
    expect(await codeOf(pending)).toBe("E_PACK_NOT_DELIVERED")
    // A kernel error passes through with its own code.
    expect(
      await codeOf(
        loadPack(async () => {
          throw new ClockworkError("E_PACK_TOO_LARGE")
        }, LEVEL),
      ),
    ).toBe("E_PACK_TOO_LARGE")
  })

  test("ownedBuffer copies exactly the bytes of a view", () => {
    const backing = new Uint8Array([9, 1, 2, 3, 9])
    const owned = ownedBuffer(backing.subarray(1, 4))
    expect([...new Uint8Array(owned)]).toEqual([1, 2, 3])
    expect(owned).not.toBe(backing.buffer)
    expect(new Uint8Array(ownedBuffer(backing.buffer))).toEqual(backing)
  })
})

/**
 * A game that names the level only in the windows it is given, and hints at
 * it every tick in `hintFrom..hintTo`, for the cases the fixture cannot reach.
 */
function windowGame(
  windows: ReadonlyArray<readonly [number, number]>,
  hint: readonly [number, number] = [-1, -1],
): () => import("../../src").GameModule {
  return () => {
    let packs: import("../../src").PackReader
    let ticks = 0
    let read = 0
    const needed = (tick: number): boolean =>
      windows.some(([from, until]) => tick >= from && tick < until)
    return {
      manifest: MANIFEST,
      init(_seed: string, _config: unknown, reader) {
        packs = reader
        packs.json(RULES)
        ticks = 0
        read = 0
      },
      tick() {
        if (needed(ticks)) {
          packs.open(LEVEL)
          read++
        }
        ticks++
      },
      packsNeeded: () => (needed(ticks) ? [LEVEL] : []),
      view: () => ({ ticks, read }),
      snapshot: () => ({ ticks, read }),
      restore(snapshot) {
        ticks = snapshot.ticks as number
        read = snapshot.read as number
      },
      score: () => ({ score: read, ticksSurvived: ticks }),
      isOver: () => ticks >= 200,
      effects: () =>
        ticks >= hint[0] && ticks < hint[1]
          ? [{ type: "prefetch", data: LEVEL }]
          : [],
    }
  }
}

describe("review fixes", () => {
  function countingLoader(bad = 0): { loader: PackLoader; calls: string[] } {
    const calls: string[] = []
    return {
      calls,
      loader: async (path) => {
        calls.push(path)
        return calls.length <= bad
          ? new Uint8Array(28)
          : (BYTES.get(path) as Uint8Array)
      },
    }
  }

  async function runWorker(
    create: () => import("../../src").GameModule,
    loader: PackLoader,
  ): Promise<{ ticks: number; errors: string[]; ended: boolean }> {
    const pair = new TransferringPair()
    runSimulationWorker(create, MANIFEST, pair.scope)
    const errors: string[] = []
    let ticks = 0
    let ended = false
    const sim = new WorkerSimulation({
      worker: pair.page,
      seed: "review",
      packs: { preloaded: START, loader },
      onFrame: (frame) => {
        ticks = frame.tick
      },
      onEnded: () => {
        ended = true
      },
      onError: (detail) => errors.push(detail),
    })
    for (let i = 0; i < 400 && !ended && errors.length === 0; i++) {
      // Five ticks a frame, so a drop and a second need land in one frame.
      sim.frame(STEP * 5)
      await settle()
    }
    return { ticks, errors, ended }
  }

  test("a worker asks again for a pack it dropped and then needs again", async () => {
    // Named for 100-101, dropped at 102, named again from 103: inside one
    // five-tick frame, after the hold at 100 that already asked for it.
    const counting = countingLoader()
    const run = await runWorker(
      windowGame([
        [100, 102],
        [103, 110],
      ]),
      counting.loader,
    )
    expect(run.errors).toEqual([])
    expect(run.ended).toBe(true)
    expect(counting.calls).toEqual([LEVEL, LEVEL])
  })

  test("a worker forgets bad bytes from a prefetch, as the page's host does", async () => {
    const counting = countingLoader(1)
    const run = await runWorker(
      windowGame([[100, 150]], [50, 51]),
      counting.loader,
    )
    expect(run.errors).toEqual([])
    expect(run.ended).toBe(true)
    // The bad prefetch, then the fetch the need made.
    expect(counting.calls).toEqual([LEVEL, LEVEL])
  })

  test("a hint repeated every tick downloads the pack once, in a worker", async () => {
    const counting = countingLoader()
    const run = await runWorker(
      windowGame([[100, 150]], [20, 90]),
      counting.loader,
    )
    expect(run.ended).toBe(true)
    expect(counting.calls).toEqual([LEVEL])
  })

  test("a hint repeated every tick downloads the pack once, in the page's host", async () => {
    const counting = countingLoader()
    const scheduler = new ManualScheduler()
    let ended = false
    const host = new GameHost({
      module: windowGame([[100, 150]], [20, 90])(),
      manifest: MANIFEST,
      seed: "review",
      scheduler,
      packs: { preloaded: START, loader: counting.loader },
      onEnded: () => {
        ended = true
      },
    })
    host.start()
    for (let i = 0; i < 400 && !ended; i++) {
      scheduler.advance(STEP)
      await settle()
    }
    expect(ended).toBe(true)
    expect(counting.calls).toEqual([LEVEL])
  })

  test("frames the host held through are counted as frames", async () => {
    const scheduler = new ManualScheduler()
    const gated = gatedLoader()
    const host = new GameHost({
      module: createGame(),
      manifest: MANIFEST,
      seed: "review",
      config: { prefetch: false },
      scheduler,
      packs: { preloaded: START, loader: gated.loader },
    })
    host.start()
    let advanced = 0
    while (host.waitingFor.length === 0 || advanced < LEVEL_FROM + 10) {
      scheduler.advance(STEP)
      advanced++
      await settle()
      if (advanced === LEVEL_FROM + 10) gated.open()
    }
    expect(host.stats.frames).toBe(advanced)
  })
})
