/**
 * @clockwork2/adapter-canvas2d
 *
 * A read-only presentation on a 2D canvas.
 *
 * The adapter owns the canvas, the device-pixel scaling and the clear; the
 * game owns one `draw` function. `draw` is handed the view, the view one tick
 * earlier and how far between them this frame sits, and it may read all three
 * and write none of them.
 */

import {
  fail,
  type Presentation,
  type PresentationContext,
} from "@clockwork2/kernel"

export type Canvas2dDraw<TView> = (
  context: CanvasRenderingContext2D,
  frame: {
    readonly view: TView
    readonly previousView: TView | null
    /** How far between the two views this frame sits, in [0, 1). */
    readonly alpha: number
    readonly dtMs: number
    readonly width: number
    readonly height: number
  },
) => void

export interface Canvas2dPresentationOptions<TView> {
  /** The simulation's coordinate space. The canvas is scaled to it. */
  readonly width: number
  readonly height: number
  readonly draw: Canvas2dDraw<TView>
  /** Filled before each frame. Leave it out to draw over what was there. */
  readonly background?: string
  /** Capped, because a phone at 3x costs nine times the pixels for little. */
  readonly maxPixelRatio?: number
  readonly onMount?: (canvas: HTMLCanvasElement) => void
}

export class Canvas2dPresentation<TView>
  implements Presentation<TView, HTMLElement>
{
  private canvas: HTMLCanvasElement | null = null
  private context: CanvasRenderingContext2D | null = null
  private pixelRatio = 1

  constructor(private readonly options: Canvas2dPresentationOptions<TView>) {}

  mount(container: HTMLElement, context: PresentationContext): void {
    const canvas = document.createElement("canvas")
    canvas.style.display = "block"
    canvas.style.width = "100%"
    canvas.style.height = "100%"
    container.appendChild(canvas)
    this.canvas = canvas
    this.pixelRatio = Math.min(
      context.devicePixelRatio || 1,
      this.options.maxPixelRatio ?? 2,
    )
    canvas.width = Math.round(this.options.width * this.pixelRatio)
    canvas.height = Math.round(this.options.height * this.pixelRatio)
    const ctx = canvas.getContext("2d")
    if (ctx === null) {
      fail("E_ENV_UNSUPPORTED", {
        detail: "this browser gave no 2d canvas context",
      })
    }
    this.context = ctx
    this.options.onMount?.(canvas)
  }

  render(
    view: TView,
    previousView: TView | null,
    alpha: number,
    dtMs: number,
  ): void {
    const context = this.context
    if (context === null) return
    const { width, height, background } = this.options
    context.setTransform(this.pixelRatio, 0, 0, this.pixelRatio, 0, 0)
    if (background === undefined) {
      context.clearRect(0, 0, width, height)
    } else {
      context.fillStyle = background
      context.fillRect(0, 0, width, height)
    }
    this.options.draw(context, {
      view,
      previousView,
      alpha,
      dtMs,
      width,
      height,
    })
  }

  unmount(): void {
    this.canvas?.remove()
    this.canvas = null
    this.context = null
  }

  get element(): HTMLCanvasElement | null {
    return this.canvas
  }
}

export function createCanvas2dPresentation<TView>(
  options: Canvas2dPresentationOptions<TView>,
): Canvas2dPresentation<TView> {
  return new Canvas2dPresentation(options)
}

export { lerp, lerpAngle, NodeSet } from "@clockwork2/kernel"
