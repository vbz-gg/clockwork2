/**
 * The Three.js presentation.
 *
 * Only `WebGLRenderer` is mocked, because it is the one piece that needs a GPU.
 * `Scene` and `PerspectiveCamera` are pure maths and run fine here, which is
 * the point: it lets `resize` be checked against a real camera's
 * `projectionMatrix` rather than against a fake that would agree with whatever
 * the adapter did.
 *
 * Building a fake WebGL context to drive the real renderer was the alternative
 * and is not worth it: the surface is enormous and a test of it would assert
 * nothing about this adapter.
 *
 * `mock.module` is process-global in bun and bun runs test files in one
 * process, so this file and the pixi one are the only places it is used, and
 * only for `three` and `pixi.js`. Nothing else under packages/, demo/tests/ or
 * skill/tests/ imports either.
 */

import { afterEach, beforeAll, describe, expect, mock, test } from "bun:test"
import { PerspectiveCamera, Scene } from "three"
import type { PresentationContext } from "../../src"

class FakeDomElement {
  readonly style: Record<string, string> = {}
  removed = false
  remove(): void {
    this.removed = true
  }
}

interface RendererOptions {
  readonly antialias?: boolean
}

class FakeRenderer {
  static built: FakeRenderer[] = []
  readonly domElement = new FakeDomElement()
  readonly sizes: Array<[number, number, boolean]> = []
  readonly rendered: Array<[Scene, PerspectiveCamera]> = []
  pixelRatio = 0
  disposed = 0
  constructor(readonly options: RendererOptions = {}) {
    FakeRenderer.built.push(this)
  }
  setPixelRatio(ratio: number): void {
    this.pixelRatio = ratio
  }
  setSize(width: number, height: number, updateStyle: boolean): void {
    this.sizes.push([width, height, updateStyle])
  }
  render(scene: Scene, camera: PerspectiveCamera): void {
    this.rendered.push([scene, camera])
  }
  dispose(): void {
    this.disposed++
  }
}

type Adapter = typeof import("../../src/adapters/three")
let adapter: Adapter

beforeAll(async () => {
  const real = await import("three")
  mock.module("three", () => ({ ...real, WebGLRenderer: FakeRenderer }))
  adapter = await import("../../src/adapters/three")
})

afterEach(() => {
  FakeRenderer.built = []
})

class FakeContainer {
  readonly children: unknown[] = []
  appendChild(child: unknown): void {
    this.children.push(child)
  }
}

type View = { readonly n: number }

type ThreeOptions = Parameters<Adapter["createThreePresentation"]>[0]

function presentation(options: Partial<ThreeOptions> = {}) {
  const drawn: Array<{ scene: Scene; camera: PerspectiveCamera }> = []
  const full = {
    width: 800,
    height: 400,
    draw: (ctx: { scene: Scene; camera: PerspectiveCamera }) => {
      drawn.push({ scene: ctx.scene, camera: ctx.camera })
    },
    ...options,
  } as ThreeOptions
  return { p: adapter.createThreePresentation<View>(full), drawn }
}

function mounted(options: Partial<ThreeOptions> = {}, ratio = 2) {
  const container = new FakeContainer()
  const ready: Array<{ camera: PerspectiveCamera; scene: Scene }> = []
  const { p, drawn } = presentation({
    onReady: (ctx) => ready.push(ctx),
    ...options,
  })
  p.mount(
    container as unknown as HTMLElement,
    {
      devicePixelRatio: ratio,
    } as PresentationContext,
  )
  // The last one built, so a test may mount more than once.
  const renderer = FakeRenderer.built[
    FakeRenderer.built.length - 1
  ] as FakeRenderer
  return { p, drawn, container, renderer, ready }
}

describe("mounting", () => {
  test("appends the renderer's own canvas, as a block that fills its box", () => {
    const { container, renderer } = mounted()
    expect(container.children).toEqual([renderer.domElement])
    expect(renderer.domElement.style.display).toBe("block")
    expect(renderer.domElement.style.width).toBe("100%")
    expect(renderer.domElement.style.height).toBe("100%")
  })

  /**
   * The third argument to setSize is false so Three does not write its own CSS
   * width and height. Passing true would have Three fight the `100%` the
   * adapter sets one line later, and the canvas would settle at whatever order
   * the two happened to run in.
   */
  test("sizes the renderer without letting it touch the CSS", () => {
    const { renderer } = mounted()
    expect(renderer.sizes).toEqual([[800, 400, false]])
  })

  test("caps the pixel ratio, and falls back from zero to one", () => {
    expect(mounted({}, 3).renderer.pixelRatio).toBe(2)
    expect(mounted({ maxPixelRatio: 3 }, 3).renderer.pixelRatio).toBe(3)
    expect(mounted({}, 0).renderer.pixelRatio).toBe(1)
  })

  test("antialias is on unless the game turns it off", () => {
    expect(mounted().renderer.options.antialias).toBe(true)
    expect(mounted({ antialias: false }).renderer.options.antialias).toBe(false)
  })

  test("the camera is built from the game's own numbers", () => {
    const { ready } = mounted({
      fieldOfView: 45,
      near: 0.5,
      far: 500,
    })
    const camera = ready[0]?.camera as PerspectiveCamera
    expect(camera.fov).toBe(45)
    expect(camera.near).toBe(0.5)
    expect(camera.far).toBe(500)
    expect(camera.aspect).toBe(2)
  })

  test("onReady hands over the scene, camera and renderer together", () => {
    // A game builds its display list here, and needs all three to do it.
    const { ready, renderer } = mounted()
    expect(ready.length).toBe(1)
    expect(ready[0]?.scene).toBeInstanceOf(Scene)
    expect(ready[0]?.camera).toBeInstanceOf(PerspectiveCamera)
    expect((ready[0] as unknown as { renderer: unknown }).renderer).toBe(
      renderer,
    )
  })
})

describe("rendering", () => {
  test("draws once per frame, then renders the scene through the camera", () => {
    const { p, drawn, renderer } = mounted()
    p.render({ n: 1 }, null, 0, 16)
    p.render({ n: 2 }, { n: 1 }, 0.5, 16)
    expect(drawn.length).toBe(2)
    expect(renderer.rendered.length).toBe(2)
  })

  test("the game draws into the same scene and camera every frame", () => {
    // A new scene per frame would throw away everything the game built in
    // onReady.
    const { p, drawn } = mounted()
    p.render({ n: 1 }, null, 0, 16)
    p.render({ n: 2 }, { n: 1 }, 0.5, 16)
    expect(drawn[0]?.scene).toBe(drawn[1]?.scene)
    expect(drawn[0]?.camera).toBe(drawn[1]?.camera)
  })

  test("renders exactly what the game was handed to draw into", () => {
    const { p, drawn, renderer } = mounted()
    p.render({ n: 1 }, null, 0, 16)
    const first = renderer.rendered[0]
    expect(first?.[0]).toBe(drawn[0]?.scene)
    expect(first?.[1]).toBe(drawn[0]?.camera)
  })

  test("Three's own animation loop is never started", () => {
    // The host owns the clock. A renderer with its own loop would step the
    // presentation between ticks and interpolate from states the simulation
    // never produced.
    const { renderer } = mounted()
    expect("setAnimationLoop" in renderer).toBe(false)
  })
})

describe("resize", () => {
  /**
   * Setting `camera.aspect` without calling `updateProjectionMatrix` is the
   * classic Three bug: the number changes and the image stays stretched,
   * because the projection matrix is only rebuilt on demand. Asserting against
   * the real camera's matrix is why `PerspectiveCamera` is left unmocked.
   */
  test("updates the aspect and rebuilds the projection matrix", () => {
    const { p, ready } = mounted()
    const camera = ready[0]?.camera as PerspectiveCamera
    const before = [...camera.projectionMatrix.elements]

    p.resize(400, 400)

    expect(camera.aspect).toBe(1)
    expect([...camera.projectionMatrix.elements]).not.toEqual(before)
  })

  test("resizes the renderer without touching the CSS, as on mount", () => {
    const { p, renderer } = mounted()
    p.resize(640, 480)
    expect(renderer.sizes[1]).toEqual([640, 480, false])
  })

  test("before a mount it does nothing", () => {
    const { p } = presentation()
    expect(() => p.resize(100, 100)).not.toThrow()
  })

  test("after an unmount it does nothing", () => {
    const { p } = mounted()
    p.unmount()
    expect(() => p.resize(100, 100)).not.toThrow()
  })
})

describe("unmount", () => {
  /**
   * An undisposed renderer leaks its WebGL context, and a browser only grants a
   * page so many before the next one fails. A host that starts a dozen sessions
   * in a tab would run out.
   */
  test("disposes the renderer and takes its canvas out of the page", () => {
    const { p, renderer } = mounted()
    p.unmount()
    expect(renderer.disposed).toBe(1)
    expect(renderer.domElement.removed).toBe(true)
  })

  test("render after unmount does nothing", () => {
    const { p, drawn, renderer } = mounted()
    p.unmount()
    expect(() => p.render({ n: 1 }, null, 0, 16)).not.toThrow()
    expect(drawn).toEqual([])
    expect(renderer.rendered).toEqual([])
  })

  test("before a mount it is harmless", () => {
    const { p } = presentation()
    expect(() => p.unmount()).not.toThrow()
  })

  test("a second unmount does not dispose twice", () => {
    const { p, renderer } = mounted()
    p.unmount()
    p.unmount()
    expect(renderer.disposed).toBe(1)
  })
})
