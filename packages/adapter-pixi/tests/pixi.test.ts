/**
 * The PIXI 8 presentation.
 *
 * `pixi.js` is mocked rather than loaded. That is not only for speed: the
 * adapter re-exports `Application`, `Container`, `Graphics` and `Text` from it,
 * so importing the adapter pulls real PIXI in, and PIXI 8's entry reaches for
 * browser globals while it is still evaluating. The mock keeps it from loading
 * at all.
 *
 * The cases below are the ones the source comments describe, and they are all
 * about `Application.init` being asynchronous while `mount` is not. A host that
 * ends one session and starts another unmounts this one while PIXI may still be
 * starting up, and the late callback has to know it no longer belongs to the
 * presentation the host is using. Without that, it appends the canvas of an
 * abandoned application and marks it started, and the next frame renders
 * through a destroyed renderer.
 *
 * `mock.module` is process-global in bun and bun runs test files in one
 * process, so this file and the three one are the only places it is used, and
 * only for `pixi.js` and `three`. Nothing else under packages/, demo/tests/ or
 * skill/tests/ imports either.
 */

import { afterEach, beforeAll, describe, expect, mock, test } from "bun:test"
import type { PresentationContext } from "@clockwork2/kernel"

class FakeCanvas {
  readonly style: Record<string, string> = {}
}

type InitOptions = Record<string, unknown>

/** An application whose init the test settles by hand. */
class FakeApplication {
  static built: FakeApplication[] = []
  readonly canvas = new FakeCanvas()
  readonly stage = { name: "stage" }
  readonly renders: number[] = []
  readonly destroys: Array<[unknown, unknown]> = []
  initOptions: InitOptions | null = null
  private settle: (() => void) | null = null
  private fail: ((reason: Error) => void) | null = null

  constructor() {
    FakeApplication.built.push(this)
  }

  init(options: InitOptions): Promise<void> {
    this.initOptions = options
    return new Promise<void>((resolve, reject) => {
      this.settle = () => resolve()
      this.fail = (reason) => reject(reason)
    })
  }

  /** Lets init resolve, then drains the microtasks its `then` runs on. */
  async ready(): Promise<void> {
    this.settle?.()
    await Promise.resolve()
    await Promise.resolve()
    await Promise.resolve()
  }

  async refuse(): Promise<void> {
    this.fail?.(new Error("no WebGL context available"))
    await Promise.resolve()
    await Promise.resolve()
    await Promise.resolve()
  }

  render(): void {
    this.renders.push(this.renders.length)
  }

  destroy(removeView: unknown, options: unknown): void {
    this.destroys.push([removeView, options])
  }
}

type Adapter = typeof import("../src/index")
let adapter: Adapter

beforeAll(async () => {
  mock.module("pixi.js", () => ({
    Application: FakeApplication,
    Container: class Container {},
    Graphics: class Graphics {},
    Text: class Text {},
  }))
  adapter = await import("../src/index")
})

afterEach(() => {
  FakeApplication.built = []
})

class FakeContainer {
  readonly children: unknown[] = []
  appendChild(child: unknown): void {
    this.children.push(child)
  }
}

type View = { readonly n: number }

type PixiOptions = Parameters<Adapter["createPixiPresentation"]>[0]

function presentation(options: Partial<PixiOptions> = {}) {
  const drawn: unknown[] = []
  const full = {
    width: 320,
    height: 180,
    draw: (stage: unknown) => {
      drawn.push(stage)
    },
    ...options,
  } as PixiOptions
  return { p: adapter.createPixiPresentation<View>(full), drawn }
}

function mount(
  p: ReturnType<typeof presentation>["p"],
  ratio = 2,
): FakeContainer {
  const container = new FakeContainer()
  p.mount(
    container as unknown as HTMLElement,
    {
      devicePixelRatio: ratio,
    } as PresentationContext,
  )
  return container
}

const built = (index = 0): FakeApplication =>
  FakeApplication.built[index] as FakeApplication

/**
 * Drains the microtask queue. unmount() chains its destroy off the init
 * promise even when that promise has already settled, so the destroy is always
 * one turn away rather than synchronous.
 */
async function flush(): Promise<void> {
  for (let i = 0; i < 4; i++) await Promise.resolve()
}

describe("how PIXI is initialised", () => {
  /**
   * The difference from Clockwork 1, where PIXI's ticker drove the engine. Here
   * PIXI is a draw call and the host owns the clock. A ticker left running would
   * step the presentation between ticks and interpolate from states the
   * simulation never produced.
   */
  test("autoStart is false, so PIXI never steps anything itself", () => {
    const { p } = presentation()
    mount(p)
    expect(built().initOptions?.autoStart).toBe(false)
  })

  test("the simulation's size and a capped resolution go in", () => {
    const { p } = presentation()
    mount(p, 3)
    expect(built().initOptions).toMatchObject({
      width: 320,
      height: 180,
      resolution: 2,
      autoDensity: true,
    })
  })

  test("resolution falls back from zero to one", () => {
    const { p } = presentation()
    mount(p, 0)
    expect(built().initOptions?.resolution).toBe(1)
  })

  test("background and antialias default, and can be set", () => {
    const { p } = presentation()
    mount(p)
    expect(built().initOptions).toMatchObject({
      background: 0x000000,
      antialias: true,
    })

    const custom = presentation({ background: 0x102030, antialias: false })
    mount(custom.p)
    expect(built(1).initOptions).toMatchObject({
      background: 0x102030,
      antialias: false,
    })
  })

  test("the canvas appears only once init has resolved", async () => {
    const { p } = presentation()
    const container = mount(p)
    expect(container.children).toEqual([])
    await built().ready()
    expect(container.children).toEqual([built().canvas])
    expect(built().canvas.style.display).toBe("block")
  })

  test("onReady is called with the application, once it is up", async () => {
    const seen: unknown[] = []
    const { p } = presentation({ onReady: (app) => seen.push(app) })
    mount(p)
    expect(seen).toEqual([])
    await built().ready()
    expect(seen).toEqual([built()])
  })

  test("whenReady before a mount resolves rather than hanging forever", async () => {
    // A host that awaited this before mounting would otherwise never start.
    const { p } = presentation()
    await expect(p.whenReady()).resolves.toBeUndefined()
  })

  test("app is the application once there is one, and null before", async () => {
    const { p } = presentation()
    expect(p.app).toBeNull()
    mount(p)
    expect(p.app).toBe(built() as never)
  })
})

describe("rendering", () => {
  test("draws into the stage and then renders, once per frame", async () => {
    const { p, drawn } = presentation()
    mount(p)
    await built().ready()
    p.render({ n: 1 }, null, 0, 16)
    p.render({ n: 2 }, { n: 1 }, 0.5, 16)
    expect(drawn).toEqual([built().stage, built().stage])
    expect(built().renders.length).toBe(2)
  })

  test("a frame before init resolves does nothing", async () => {
    // There is no renderer yet. The first few frames after a mount are simply
    // not drawn, which is what whenReady is for.
    const { p, drawn } = presentation()
    mount(p)
    p.render({ n: 1 }, null, 0, 16)
    expect(drawn).toEqual([])
    expect(built().renders).toEqual([])
  })

  test("a frame before a mount does nothing", () => {
    const { p, drawn } = presentation()
    expect(() => p.render({ n: 1 }, null, 0, 16)).not.toThrow()
    expect(drawn).toEqual([])
  })
})

describe("unmounting while PIXI is still starting", () => {
  /**
   * The race the source comment describes. Without the generation counter the
   * late init callback appends the canvas of an abandoned application and marks
   * it started, and the next frame renders through a destroyed renderer.
   */
  test("the late callback does not append the abandoned canvas", async () => {
    const { p, drawn } = presentation()
    const container = mount(p)
    p.unmount()
    await built().ready()

    expect(container.children).toEqual([])
    p.render({ n: 1 }, null, 0, 16)
    expect(drawn).toEqual([])
  })

  /**
   * And the destroy waits for init to settle before running. Destroying an
   * application mid-init leaves its canvas and its WebGL context behind, and a
   * browser only grants a page so many before the next one fails.
   */
  test("the destroy waits for init, then runs exactly once", async () => {
    const { p } = presentation()
    mount(p)
    p.unmount()
    await flush()
    // Still nothing: init has not settled, so there is nothing safe to destroy.
    expect(built().destroys).toEqual([])

    await built().ready()
    await flush()
    expect(built().destroys).toEqual([[true, { children: true }]])
  })

  test("and it still runs when init rejected", async () => {
    // Otherwise a machine with no WebGL leaks a context per attempt, which is
    // the case most likely to be attempting repeatedly.
    const { p } = presentation()
    mount(p)
    p.unmount()
    await built().refuse()
    await flush()
    expect(built().destroys).toEqual([[true, { children: true }]])
  })

  test("a second mount is not stolen by the first init", async () => {
    // A host that ends one session and starts another immediately gets two
    // applications in flight. The first callback must not touch the second
    // container.
    const { p } = presentation()
    const first = mount(p)
    p.unmount()
    const second = mount(p)

    await built(0).ready()
    expect(first.children).toEqual([])
    expect(second.children).toEqual([])

    await built(1).ready()
    expect(second.children).toEqual([built(1).canvas])
    expect(first.children).toEqual([])
  })

  test("the abandoned application is destroyed and the live one is not", async () => {
    const { p } = presentation()
    mount(p)
    p.unmount()
    mount(p)
    await built(0).ready()
    await built(1).ready()
    await flush()
    expect(built(0).destroys.length).toBe(1)
    expect(built(1).destroys).toEqual([])
  })
})

describe("unmounting once PIXI is up", () => {
  test("destroys the application and stops rendering", async () => {
    const { p, drawn } = presentation()
    mount(p)
    await built().ready()
    p.unmount()
    await flush()

    expect(built().destroys).toEqual([[true, { children: true }]])
    p.render({ n: 1 }, null, 0, 16)
    expect(drawn).toEqual([])
    expect(p.app).toBeNull()
  })

  test("unmount before a mount is harmless", () => {
    const { p } = presentation()
    expect(() => p.unmount()).not.toThrow()
    expect(FakeApplication.built).toEqual([])
  })

  test("a second unmount does not destroy twice", async () => {
    const { p } = presentation()
    mount(p)
    await built().ready()
    p.unmount()
    p.unmount()
    await flush()
    expect(built().destroys.length).toBe(1)
  })
})
