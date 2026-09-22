/**
 * The worker mode, and whether it agrees with the inline one.
 *
 * A fake worker pair stands in for a real one so the test is synchronous and
 * needs no browser. What it exercises is the real code on both sides: the
 * same `runSimulationWorker` a game's worker entry calls, and the same
 * `WorkerSimulation` a page uses.
 */

import { describe, expect, test } from "bun:test"
import { RecordedInputSource, runSession } from "@clockwork2/kernel"
import {
  botLog,
  createReferenceGame,
  REFERENCE_CONFIG,
  REFERENCE_MANIFEST,
} from "@clockwork2/kernel/testing"
import { GameHost, ManualScheduler } from "../src/index"
import {
  type FromWorker,
  runSimulationWorker,
  type ToWorker,
  WorkerSimulation,
} from "../src/worker/index"

type Listener = (event: { data: unknown }) => void

/**
 * Two ends of a channel. Delivery is synchronous by default, which keeps a
 * test from having to wait for anything; `deferred` queues instead, so
 * backpressure can be exercised.
 */
class FakeWorkerPair {
  private pageListeners: Listener[] = []
  private scopeListeners: Listener[] = []
  private queued: Array<() => void> = []

  constructor(private readonly deferred = false) {}

  readonly page = {
    postMessage: (message: unknown): void => {
      this.deliver(this.scopeListeners, message)
    },
    addEventListener: (_type: string, listener: Listener): void => {
      this.pageListeners.push(listener)
    },
    terminate: (): void => {
      this.pageListeners = []
      this.scopeListeners = []
    },
  } as unknown as Worker

  readonly scope = {
    postMessage: (message: FromWorker): void => {
      this.deliver(this.pageListeners, message)
    },
    addEventListener: (_type: "message", listener: Listener): void => {
      this.scopeListeners.push(listener)
    },
  }

  private deliver(listeners: readonly Listener[], message: unknown): void {
    const run = (): void => {
      for (const listener of [...listeners]) listener({ data: message })
    }
    if (this.deferred) this.queued.push(run)
    else run()
  }

  /** Delivers everything waiting, for the deferred case. */
  flush(): void {
    while (this.queued.length > 0) {
      const next = this.queued.shift() as () => void
      next()
    }
  }

  get pending(): number {
    return this.queued.length
  }
}

describe("the worker protocol", () => {
  test("a session in the worker reaches the same state as one inline", () => {
    const log = botLog("parity", 20_000)

    const inline = runSession({
      module: createReferenceGame(),
      seed: "parity",
      config: REFERENCE_CONFIG,
      inputs: new RecordedInputSource(log),
      maxTicks: REFERENCE_MANIFEST.session.maxTicks,
      checkpointEvery: 60,
      counters: REFERENCE_MANIFEST.counters,
    })

    const pair = new FakeWorkerPair()
    runSimulationWorker(createReferenceGame, REFERENCE_MANIFEST, pair.scope)
    const checkpoints: Array<{ tick: number; hash: string }> = []
    let ended: { endTick: number; counters: Record<string, number> } | null =
      null
    const simulation = new WorkerSimulation({
      worker: pair.page,
      seed: "parity",
      config: REFERENCE_CONFIG,
      onCheckpoint: (checkpoint) => checkpoints.push(checkpoint),
      onEnded: (result) => {
        ended = { endTick: result.endTick, counters: result.counters }
      },
    })

    // Feed the recorded log by pushing each input on the frame that covers its
    // tick, which is what the page does with a live player.
    let tick = 0
    let cursor = 0
    while (ended === null && tick < 40_000) {
      const due = []
      while (
        cursor < log.length &&
        (log[cursor] as { tick: number }).tick <= tick
      ) {
        const input = log[cursor] as {
          device: "key"
          code: string
          value: number
        }
        due.push({ device: input.device, code: input.code, value: input.value })
        cursor++
      }
      simulation.send(due)
      simulation.frame(1000 / 60)
      tick++
    }

    expect(ended).not.toBeNull()
    const result = ended as unknown as {
      endTick: number
      counters: Record<string, number>
    }
    expect(result.endTick).toBe(inline.endTick)
    expect(result.counters).toEqual(inline.counters)
    expect(checkpoints).toEqual([...inline.checkpoints])
  })

  test("the view it sends survives a structured clone", () => {
    // In a real worker the view is cloned on the way out. A view holding a
    // class instance would throw there and nowhere else, so it is checked
    // here where the failure is cheap.
    const pair = new FakeWorkerPair()
    runSimulationWorker(createReferenceGame, REFERENCE_MANIFEST, pair.scope)
    let view: unknown = null
    const simulation = new WorkerSimulation({
      worker: pair.page,
      seed: "clone",
      config: REFERENCE_CONFIG,
      onFrame: (frame) => {
        view = frame.view
      },
    })
    simulation.frame(1000 / 60)
    expect(view).not.toBeNull()
    expect(() => structuredClone(view)).not.toThrow()
  })

  test("only one frame is outstanding, and nothing is lost", () => {
    const pair = new FakeWorkerPair(true)
    runSimulationWorker(createReferenceGame, REFERENCE_MANIFEST, pair.scope)
    const simulation = new WorkerSimulation({
      worker: pair.page,
      seed: "backpressure",
      config: REFERENCE_CONFIG,
    })
    pair.flush() // let init through, so the simulation is ready

    // Ten frames offered while the worker has not answered.
    for (let i = 0; i < 10; i++) simulation.frame(1000 / 60)
    const sent = pair.pending
    // One frame message, not ten: the rest of the time is carried.
    expect(sent).toBe(1)

    pair.flush()
    // The carried time goes out on the next offer rather than being lost.
    simulation.frame(0)
    pair.flush()
    expect(pair.pending).toBe(0)
  })

  test("an error in the worker is reported rather than swallowed", () => {
    const pair = new FakeWorkerPair()
    runSimulationWorker(
      () => {
        throw new Error("the module would not load")
      },
      REFERENCE_MANIFEST,
      pair.scope,
    )
    const errors: string[] = []
    new WorkerSimulation({
      worker: pair.page,
      seed: "broken",
      onError: (message) => {
        errors.push(message)
      },
    })
    expect(errors.join(" ")).toContain("the module would not load")
  })

  test("the message shapes are the ones the types declare", () => {
    const toWorker: ToWorker[] = [
      { type: "init", seed: "s", config: {} },
      { type: "input", inputs: [{ device: "key", code: "left", value: 1 }] },
      { type: "frame", elapsedMs: 16, frameId: 0 },
      { type: "stop" },
    ]
    expect(toWorker.map((m) => m.type)).toEqual([
      "init",
      "input",
      "frame",
      "stop",
    ])
  })
})

describe("worker and inline hosts", () => {
  test("agree on a live session recorded through either one", () => {
    // Same seed, same inputs on the same ticks, both modes.
    const scheduler = new ManualScheduler()
    const inlineHost = new GameHost({
      module: createReferenceGame(),
      manifest: REFERENCE_MANIFEST,
      seed: "both",
      config: REFERENCE_CONFIG,
      scheduler,
      checkpointEvery: 60,
    })
    inlineHost.start()
    for (let frame = 0; frame < 900 && inlineHost.status !== "ended"; frame++) {
      if (frame % 23 === 0) {
        inlineHost.live?.push({
          device: "key",
          code: "thrust",
          value: frame % 46 === 0 ? 1 : 0,
        })
      }
      scheduler.advance(1000 / 60)
    }
    inlineHost.stop()
    const recording = inlineHost.recording()

    const pair = new FakeWorkerPair()
    runSimulationWorker(createReferenceGame, REFERENCE_MANIFEST, pair.scope)
    const checkpoints: Array<{ tick: number; hash: string }> = []
    const simulation = new WorkerSimulation({
      worker: pair.page,
      seed: "both",
      config: REFERENCE_CONFIG,
      onCheckpoint: (checkpoint) => checkpoints.push(checkpoint),
    })
    let cursor = 0
    for (let tick = 0; tick < recording.endTick; tick++) {
      const due = []
      while (
        cursor < recording.inputs.length &&
        (recording.inputs[cursor] as { tick: number }).tick <= tick
      ) {
        const input = recording.inputs[cursor] as {
          device: "key"
          code: string
          value: number
        }
        due.push({ device: input.device, code: input.code, value: input.value })
        cursor++
      }
      simulation.send(due)
      simulation.frame(1000 / 60)
    }
    const common = recording.checkpoints.filter((c) =>
      checkpoints.some((other) => other.tick === c.tick),
    )
    expect(common.length).toBeGreaterThan(5)
    for (const checkpoint of common) {
      const other = checkpoints.find((c) => c.tick === checkpoint.tick)
      expect(other?.hash, `tick ${checkpoint.tick}`).toBe(checkpoint.hash)
    }
  })
})

describe("stopping a worker session", () => {
  /**
   * A page that navigates away, or a host that ends a session early, has to be
   * able to stop the simulation. Without it the worker keeps stepping a session
   * nobody is watching, on a thread the page cannot reclaim, for as long as the
   * tab is open.
   */
  test("stop reaches the worker and the session stops reporting", () => {
    const pair = new FakeWorkerPair()
    runSimulationWorker(createReferenceGame, REFERENCE_MANIFEST, pair.scope)
    const checkpoints: Array<{ tick: number }> = []
    let ended = false
    const simulation = new WorkerSimulation({
      worker: pair.page,
      seed: "stop-me",
      config: REFERENCE_CONFIG,
      onCheckpoint: (checkpoint) => checkpoints.push(checkpoint),
      onEnded: () => {
        ended = true
      },
    })

    for (let i = 0; i < 200; i++) simulation.frame(1000 / 60)
    const beforeStop = checkpoints.length
    expect(beforeStop).toBeGreaterThan(0)
    expect(ended).toBe(false)

    // Abandoning takes a final checkpoint at the tick actually reached. That
    // is the one that matters: a recording has to end where the run ended, or
    // it replays to a state the player never saw.
    simulation.stop()
    expect(checkpoints.length).toBe(beforeStop + 1)
    const last = checkpoints[checkpoints.length - 1]?.tick ?? -1

    for (let i = 0; i < 200; i++) simulation.frame(1000 / 60)
    expect(ended).toBe(true)
    // Nothing advanced past where it stopped.
    expect(checkpoints[checkpoints.length - 1]?.tick).toBe(last)
  })
})
