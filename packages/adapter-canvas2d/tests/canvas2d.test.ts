/**
 * The 2D canvas presentation.
 *
 * A fake document stands in for a browser, installed on globalThis behind a
 * save-and-restore stack, which is the idiom packages/host-bridge/tests
 * already uses. The alternative was adding an injection seam to the adapter so
 * a test could pass its own document, and changing shipping code to suit a test
 * is the worse trade.
 *
 * What is worth pinning is the small set of things this adapter owns on the
 * game's behalf: the device-pixel scaling, the clear, and the two orderings a
 * host can put it through. A game that drew nothing on a retina display, or
 * trailed ghosts because a clear became a fill, would look like a bug in the
 * game.
 */

import { afterEach, describe, expect, test } from "bun:test"
import type { PresentationContext } from "@clockwork2/kernel"
import {
  type Canvas2dPresentationOptions,
  createCanvas2dPresentation,
} from "../src/index"

type Call = [string, ...unknown[]]

class FakeContext {
  readonly calls: Call[] = []
  fillStyle = ""
  setTransform(...args: unknown[]): void {
    this.calls.push(["setTransform", ...args])
  }
  clearRect(...args: unknown[]): void {
    this.calls.push(["clearRect", ...args])
  }
  fillRect(...args: unknown[]): void {
    this.calls.push(["fillRect", ...args, this.fillStyle])
  }
  of(name: string): Call[] {
    return this.calls.filter((c) => c[0] === name)
  }
}

class FakeCanvas {
  readonly style: Record<string, string> = {}
  width = 0
  height = 0
  removed = false
  readonly context = new FakeContext()
  constructor(private readonly giveContext: boolean) {}
  getContext(kind: string): FakeContext | null {
    if (!this.giveContext || kind !== "2d") return null
    return this.context
  }
  remove(): void {
    this.removed = true
  }
}

class FakeContainer {
  readonly children: FakeCanvas[] = []
  appendChild(child: FakeCanvas): void {
    this.children.push(child)
  }
}

const restores: Array<() => void> = []
afterEach(() => {
  while (restores.length > 0) restores.pop()?.()
})

function install(options: { giveContext?: boolean } = {}): {
  canvas: FakeCanvas
  container: FakeContainer
} {
  const canvas = new FakeCanvas(options.giveContext !== false)
  const container = new FakeContainer()
  const target = globalThis as unknown as Record<string, unknown>
  const had = "document" in target
  const saved = target.document
  target.document = { createElement: () => canvas }
  restores.push(() => {
    if (had) target.document = saved
    else delete target.document
  })
  return { canvas, container }
}

function context(devicePixelRatio: number): PresentationContext {
  return { devicePixelRatio } as PresentationContext
}

type View = { readonly n: number }

function presentation(
  options: Partial<Canvas2dPresentationOptions<View>> = {},
) {
  const drawn: Array<Record<string, unknown>> = []
  const full: Canvas2dPresentationOptions<View> = {
    width: 320,
    height: 180,
    draw: (_context, frame) => {
      drawn.push({ ...frame })
    },
    ...options,
  }
  return { p: createCanvas2dPresentation<View>(full), drawn }
}

describe("mounting", () => {
  test("puts one canvas in the container and hands it back", () => {
    const { canvas, container } = install()
    const { p } = presentation()
    p.mount(container as unknown as HTMLElement, context(1))
    expect(container.children).toEqual([canvas])
    expect(p.element).toBe(canvas as unknown as HTMLCanvasElement)
  })

  test("element is null before a mount", () => {
    install()
    expect(presentation().p.element).toBeNull()
  })

  test("the canvas fills its container by CSS and is a block", () => {
    // An inline canvas sits on a text baseline and leaves a gap under it, which
    // is the classic "why is there a scrollbar" in an embedded game.
    const { canvas, container } = install()
    const { p } = presentation()
    p.mount(container as unknown as HTMLElement, context(1))
    expect(canvas.style.display).toBe("block")
    expect(canvas.style.width).toBe("100%")
    expect(canvas.style.height).toBe("100%")
  })

  test("calls onMount with the canvas, for a host that wants to bind to it", () => {
    const { canvas, container } = install()
    const seen: unknown[] = []
    const { p } = presentation({ onMount: (c) => seen.push(c) })
    p.mount(container as unknown as HTMLElement, context(1))
    expect(seen).toEqual([canvas])
  })

  /**
   * A browser refuses a context when too many are already live on the page, and
   * on some locked-down configurations. Failing here with a named error beats
   * carrying a null through to the first render and throwing a TypeError three
   * frames later, where nothing says what went wrong.
   */
  test("no 2d context is a named refusal, not a TypeError later", () => {
    const { container } = install({ giveContext: false })
    const { p } = presentation()
    expect(() =>
      p.mount(container as unknown as HTMLElement, context(1)),
    ).toThrow(/E_ENV_UNSUPPORTED/)
  })
})

describe("the backing store", () => {
  test("is the simulation's size times the device pixel ratio", () => {
    const { canvas, container } = install()
    const { p } = presentation()
    p.mount(container as unknown as HTMLElement, context(2))
    expect([canvas.width, canvas.height]).toEqual([640, 360])
  })

  /**
   * The cap the source justifies: a phone at 3x costs nine times the pixels for
   * little. Without it a mid-range phone renders 1.7 megapixels of a 320x180
   * game.
   */
  test("caps the ratio, because three times costs nine times the pixels", () => {
    const { canvas, container } = install()
    const { p } = presentation()
    p.mount(container as unknown as HTMLElement, context(3))
    expect([canvas.width, canvas.height]).toEqual([640, 360])
  })

  test("the cap can be raised or lowered by the game", () => {
    const { canvas, container } = install()
    const { p } = presentation({ maxPixelRatio: 3 })
    p.mount(container as unknown as HTMLElement, context(3))
    expect([canvas.width, canvas.height]).toEqual([960, 540])
  })

  /**
   * A background tab can report 0. Without the fallback the backing store would
   * be zero pixels wide and the game would draw nothing at all, then come back
   * blank when the tab was focused again.
   */
  test("a device pixel ratio of zero falls back to one", () => {
    const { canvas, container } = install()
    const { p } = presentation()
    p.mount(container as unknown as HTMLElement, context(0))
    expect([canvas.width, canvas.height]).toEqual([320, 180])
  })

  test("a fractional ratio is rounded, not truncated into a gap", () => {
    const { canvas, container } = install()
    const { p } = presentation()
    p.mount(container as unknown as HTMLElement, context(1.5))
    expect([canvas.width, canvas.height]).toEqual([480, 270])
  })
})

describe("rendering", () => {
  function mounted(
    options: Parameters<typeof presentation>[0] = {},
    ratio = 2,
  ) {
    const { canvas, container } = install()
    const { p, drawn } = presentation(options)
    p.mount(container as unknown as HTMLElement, context(ratio))
    return { p, drawn, canvas, ctx: canvas.context }
  }

  /**
   * The transform is set every frame, not once at mount. A game that changed it
   * mid-draw, which any game with a camera does, would otherwise have its next
   * frame land in the wrong place, and only on a retina display.
   */
  test("resets the transform to the pixel ratio on every frame", () => {
    const { p, ctx } = mounted()
    p.render({ n: 1 }, null, 0, 16)
    p.render({ n: 2 }, { n: 1 }, 0.5, 16)
    expect(ctx.of("setTransform")).toEqual([
      ["setTransform", 2, 0, 0, 2, 0, 0],
      ["setTransform", 2, 0, 0, 2, 0, 0],
    ])
  })

  /**
   * With no background the canvas is cleared, so whatever the page put behind
   * it shows through. A game expecting that and getting a fill loses its
   * backdrop; one expecting a fill and getting a clear trails ghosts.
   */
  test("no background clears, rather than filling with anything", () => {
    const { p, ctx } = mounted()
    p.render({ n: 1 }, null, 0, 16)
    expect(ctx.of("clearRect")).toEqual([["clearRect", 0, 0, 320, 180]])
    expect(ctx.of("fillRect")).toEqual([])
  })

  test("a background fills with it, in the simulation's coordinates", () => {
    const { p, ctx } = mounted({ background: "#101820" })
    p.render({ n: 1 }, null, 0, 16)
    expect(ctx.of("clearRect")).toEqual([])
    expect(ctx.of("fillRect")).toEqual([
      ["fillRect", 0, 0, 320, 180, "#101820"],
    ])
  })

  test("hands the game both views, the alpha and the frame time", () => {
    const { p, drawn } = mounted()
    p.render({ n: 2 }, { n: 1 }, 0.25, 16.7)
    expect(drawn).toEqual([
      {
        view: { n: 2 },
        previousView: { n: 1 },
        alpha: 0.25,
        dtMs: 16.7,
        width: 320,
        height: 180,
      },
    ])
  })

  test("the first frame has no previous view, and says so", () => {
    // A game that read previousView without checking would interpolate from
    // undefined on its very first frame.
    const { p, drawn } = mounted()
    p.render({ n: 1 }, null, 0, 16)
    expect(drawn[0]?.previousView).toBeNull()
  })
})

describe("the orderings a host can produce", () => {
  /**
   * A host can race a render against a mount, and does when a session starts
   * while a previous one is tearing down. Neither may throw: the frame is
   * simply not drawn.
   */
  test("render before mount does nothing", () => {
    install()
    const { p, drawn } = presentation()
    expect(() => p.render({ n: 1 }, null, 0, 16)).not.toThrow()
    expect(drawn).toEqual([])
  })

  test("render after unmount does nothing", () => {
    const { container } = install()
    const { p, drawn } = presentation()
    p.mount(container as unknown as HTMLElement, context(1))
    p.unmount()
    expect(() => p.render({ n: 1 }, null, 0, 16)).not.toThrow()
    expect(drawn).toEqual([])
  })

  test("unmount removes the canvas and forgets it", () => {
    const { canvas, container } = install()
    const { p } = presentation()
    p.mount(container as unknown as HTMLElement, context(1))
    p.unmount()
    expect(canvas.removed).toBe(true)
    expect(p.element).toBeNull()
  })

  test("unmount before mount is harmless", () => {
    install()
    expect(() => presentation().p.unmount()).not.toThrow()
  })

  test("mounting again after an unmount works", () => {
    const { container } = install()
    const { p, drawn } = presentation()
    p.mount(container as unknown as HTMLElement, context(1))
    p.unmount()
    p.mount(container as unknown as HTMLElement, context(1))
    p.render({ n: 1 }, null, 0, 16)
    expect(drawn.length).toBe(1)
    expect(p.element).not.toBeNull()
  })
})
