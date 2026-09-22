/**
 * The audio sink.
 *
 * Its whole contract is in one line of its own source: "No audio is a missing
 * flourish, never a broken game." Everything below is a way that could stop
 * being true. A context that cannot be built, a recipe that throws, an effect
 * whose payload is not what the type says, a browser that refuses to resume -
 * none of them may reach the tick loop, and none of them may cost the player
 * anything but the sound.
 *
 * A fake AudioContext stands in for the browser's, installed on globalThis and
 * restored afterwards, which is the idiom frame.test.ts already uses. Under bun
 * there is no AudioContext at all, so without one of these the sink latches as
 * failed on its first effect and nothing after that runs.
 */

import { afterEach, describe, expect, test } from "bun:test"
import type { Effect } from "../../src"
import { AudioSink } from "../../src/host/audio"

class FakeBuffer {
  readonly channel: Float32Array
  constructor(readonly samples: number) {
    this.channel = new Float32Array(samples)
  }
  getChannelData(): Float32Array {
    return this.channel
  }
}

class FakeSource {
  buffer: FakeBuffer | null = null
  started = 0
  connectedTo: unknown = null
  connect(node: unknown): unknown {
    this.connectedTo = node
    return node
  }
  start(): void {
    this.started++
  }
}

class FakeGain {
  readonly gain = { value: 0 }
  connectedTo: unknown = null
  connect(node: unknown): unknown {
    this.connectedTo = node
    return node
  }
}

interface FakeOptions {
  readonly constructorThrows?: boolean
  readonly sourceThrows?: boolean
  readonly resumeRejects?: boolean
  readonly state?: "running" | "suspended"
  readonly sampleRate?: number
}

let built = 0
let contexts: FakeContext[] = []
let current: FakeOptions = {}

/**
 * Registers itself on construction, so installAudio can hand this class
 * straight to globalThis rather than wrapping it in a constructor that returns
 * something else.
 */
class FakeContext {
  readonly sampleRate: number
  readonly destination = { name: "destination" }
  readonly sources: FakeSource[] = []
  readonly gains: FakeGain[] = []
  state: "running" | "suspended"
  resumed = 0
  closed = 0
  private readonly options: FakeOptions = current
  constructor() {
    built++
    if (current.constructorThrows === true) {
      throw new Error("the browser said no")
    }
    this.sampleRate = current.sampleRate ?? 48_000
    this.state = current.state ?? "running"
    contexts.push(this)
  }
  createBuffer(_channels: number, samples: number): FakeBuffer {
    return new FakeBuffer(samples)
  }
  createBufferSource(): FakeSource {
    if (this.options.sourceThrows === true) throw new Error("no more sources")
    const source = new FakeSource()
    this.sources.push(source)
    return source
  }
  createGain(): FakeGain {
    const gain = new FakeGain()
    this.gains.push(gain)
    return gain
  }
  async resume(): Promise<void> {
    this.resumed++
    if (this.options.resumeRejects === true) throw new Error("gesture required")
    this.state = "running"
  }
  async close(): Promise<void> {
    this.closed++
  }
}

const restores: Array<() => void> = []
afterEach(() => {
  while (restores.length > 0) restores.pop()?.()
  built = 0
  contexts = []
  current = {}
})

function installAudio(options: FakeOptions = {}): void {
  current = options
  const target = globalThis as unknown as Record<string, unknown>
  const had = "AudioContext" in target
  const saved = target.AudioContext
  target.AudioContext = FakeContext
  restores.push(() => {
    if (had) target.AudioContext = saved
    else delete target.AudioContext
  })
}

/** A recipe that writes a recognisable ramp, so its output can be checked. */
const ramp = (
  _rate: number,
  write: (index: number, value: number) => void,
  samples: number,
): void => {
  for (let i = 0; i < samples; i++) write(i, i / samples)
}

function sink(over: Partial<Parameters<typeof makeOptions>[0]> = {}) {
  return new AudioSink(makeOptions(over))
}

function makeOptions(over: {
  volume?: number
  recipe?: typeof ramp
  seconds?: number
}) {
  return {
    sounds: {
      blip: { seconds: over.seconds ?? 0.25, recipe: over.recipe ?? ramp },
    },
    ...(over.volume === undefined ? {} : { volume: over.volume }),
  }
}

const sound = (data: unknown): Effect => ({ type: "sound", data }) as Effect

describe("building the context", () => {
  test("is deferred until the first effect", () => {
    installAudio()
    sink()
    expect(built).toBe(0)
  })

  test("fills one buffer per declared sound, at the context's own rate", () => {
    installAudio({ sampleRate: 44_100 })
    sink({ seconds: 0.5 }).play("blip")
    const context = contexts[0] as FakeContext
    // floor(44100 * 0.5). A buffer sized from an assumed 48k would play the
    // sound at the wrong speed on hardware that runs at 44.1k.
    const buffer = context.sources[0]?.buffer
    expect(buffer?.samples).toBe(22_050)
  })

  test("the recipe's writes reach the buffer", () => {
    installAudio({ sampleRate: 1000 })
    sink({ seconds: 0.01 }).play("blip")
    const buffer = contexts[0]?.sources[0]?.buffer
    expect(buffer?.samples).toBe(10)
    // The channel is a Float32Array, so the ramp arrives rounded to float32.
    // Comparing against the doubles the recipe wrote would fail on the third
    // sample and say nothing about whether the writes landed.
    expect([...(buffer?.channel ?? [])]).toEqual(
      Array.from({ length: 10 }, (_, i) => Math.fround(i / 10)),
    )
  })

  test("is built once and kept", () => {
    installAudio()
    const s = sink()
    s.play("blip")
    s.play("blip")
    s.play("blip")
    expect(built).toBe(1)
  })
})

describe("when there is no audio to be had", () => {
  /**
   * The latch is the point. Without it every effect in every frame would build
   * a context, and a game emitting a sound per tick would try sixty times a
   * second for the whole session.
   */
  test("a context that will not build is tried once, not once per effect", () => {
    installAudio({ constructorThrows: true })
    const s = sink()
    s.play("blip")
    s.play("blip")
    s.play("blip")
    expect(built).toBe(1)
  })

  test("and nothing escapes to the caller", () => {
    installAudio({ constructorThrows: true })
    expect(() => sink().handle([sound("blip")])).not.toThrow()
  })

  /**
   * A recipe is game code. One that throws must cost the game its sound and
   * nothing else - certainly not the frame it was emitted in.
   */
  test("a recipe that throws costs the sound, not the frame", () => {
    installAudio()
    const exploding = (): void => {
      throw new Error("bad maths in the recipe")
    }
    const s = new AudioSink({
      sounds: { blip: { seconds: 0.1, recipe: exploding } },
    })
    expect(() => s.play("blip")).not.toThrow()
    expect(contexts[0]?.sources ?? []).toEqual([])
  })

  test("a source that will not start is not a thrown error either", () => {
    installAudio({ sourceThrows: true })
    expect(() => sink().play("blip")).not.toThrow()
  })

  test("with no AudioContext in the runtime at all", () => {
    // Which is every headless run of the suite, and every server replay.
    const target = globalThis as unknown as Record<string, unknown>
    const had = "AudioContext" in target
    const saved = target.AudioContext
    delete target.AudioContext
    restores.push(() => {
      if (had) target.AudioContext = saved
    })
    expect(() => sink().handle([sound("blip")])).not.toThrow()
  })
})

describe("handling effects", () => {
  test("plays a sound effect", () => {
    installAudio()
    sink().handle([sound("blip")])
    expect(contexts[0]?.sources.length).toBe(1)
    expect(contexts[0]?.sources[0]?.started).toBe(1)
  })

  /**
   * `data` is typed as a string, but effects cross a worker boundary and come
   * back as whatever was on the wire. The sink skips anything else rather than
   * looking it up and finding undefined.
   */
  test("ignores a sound whose data is not a string", () => {
    installAudio()
    sink().handle([sound(42), sound(null), sound({ name: "blip" })])
    expect(built).toBe(0)
  })

  test("ignores effects that are not sounds", () => {
    installAudio()
    sink().handle([
      { type: "haptic", data: "blip" } as Effect,
      { type: "score", data: 10 } as Effect,
    ])
    expect(built).toBe(0)
  })

  test("a name with no recipe is a no-op, not a crash", () => {
    installAudio()
    const s = sink()
    expect(() => s.play("nothing-by-that-name")).not.toThrow()
    expect(contexts[0]?.sources ?? []).toEqual([])
  })

  test("plays every sound in one batch, in order", () => {
    installAudio()
    const s = new AudioSink({
      sounds: {
        a: { seconds: 0.1, recipe: ramp },
        b: { seconds: 0.1, recipe: ramp },
      },
    })
    s.handle([sound("a"), sound("b"), sound("a")])
    expect(contexts[0]?.sources.length).toBe(3)
  })
})

describe("volume", () => {
  test("defaults to something below full scale", () => {
    // Full scale on a generated square wave is unpleasant and clips.
    installAudio()
    sink().play("blip")
    expect(contexts[0]?.gains[0]?.gain.value).toBe(0.3)
  })

  test("is taken from the options when given", () => {
    installAudio()
    sink({ volume: 0.75 }).play("blip")
    expect(contexts[0]?.gains[0]?.gain.value).toBe(0.75)
  })

  test("routes the source through the gain to the destination", () => {
    installAudio()
    sink().play("blip")
    const context = contexts[0] as FakeContext
    expect(context.sources[0]?.connectedTo).toBe(context.gains[0])
    expect(context.gains[0]?.connectedTo).toBe(context.destination)
  })
})

describe("unlock", () => {
  test("resumes a suspended context", async () => {
    installAudio({ state: "suspended" })
    await sink().unlock()
    expect(contexts[0]?.resumed).toBe(1)
    expect(contexts[0]?.state).toBe("running")
  })

  test("leaves a running context alone", async () => {
    installAudio({ state: "running" })
    await sink().unlock()
    expect(contexts[0]?.resumed).toBe(0)
  })

  /**
   * Browsers reject resume when the gesture was not close enough to it. The
   * next gesture may work, so this is not a failure to report anywhere.
   */
  test("a rejected resume is swallowed", async () => {
    installAudio({ state: "suspended", resumeRejects: true })
    await expect(sink().unlock()).resolves.toBeUndefined()
  })

  test("with no context to be had, resolves rather than throwing", async () => {
    installAudio({ constructorThrows: true })
    await expect(sink().unlock()).resolves.toBeUndefined()
  })
})

describe("close", () => {
  test("closes the context and drops the buffers", () => {
    installAudio()
    const s = sink()
    s.play("blip")
    s.close()
    expect(contexts[0]?.closed).toBe(1)
  })

  /**
   * A host that ends one session and starts another closes the sink in
   * between. The buffers belong to the closed context, so the next play has to
   * build both again rather than hand a dead buffer to a live context.
   */
  test("a later play builds a fresh context and fresh buffers", () => {
    installAudio()
    const s = sink()
    s.play("blip")
    s.close()
    s.play("blip")
    expect(built).toBe(2)
    expect(contexts[1]?.sources.length).toBe(1)
  })

  test("closing before anything played is harmless", () => {
    installAudio()
    expect(() => sink().close()).not.toThrow()
    expect(built).toBe(0)
  })
})
