/**
 * @clockwork2/adapter-pixi
 *
 * A read-only presentation on PIXI 8.
 *
 * PIXI is initialised with `autoStart: false` and the adapter calls
 * `app.render()` itself, once per host frame. That is the whole difference
 * from Clockwork 1, where PIXI's ticker drove the engine: here PIXI is a draw
 * call and the host owns the clock.
 *
 * `Application.init` is asynchronous in PIXI 8 and `mount` is not, so the
 * first few frames after mounting do nothing and `whenReady()` resolves once
 * there is something to draw on.
 */

import type { Presentation, PresentationContext } from "@clockwork2/kernel"
import { Application, type Container } from "pixi.js"

export type PixiDraw<TView> = (
  stage: Container,
  frame: {
    readonly view: TView
    readonly previousView: TView | null
    readonly alpha: number
    readonly dtMs: number
  },
) => void

export interface PixiPresentationOptions<TView> {
  readonly width: number
  readonly height: number
  readonly draw: PixiDraw<TView>
  readonly background?: number
  readonly antialias?: boolean
  readonly maxPixelRatio?: number
  /** Called once PIXI is up, for a game that builds its display list there. */
  readonly onReady?: (application: Application) => void
}

export class PixiPresentation<TView>
  implements Presentation<TView, HTMLElement>
{
  private application: Application | null = null
  private ready: Promise<void> | null = null
  private started = false

  constructor(private readonly options: PixiPresentationOptions<TView>) {}

  mount(container: HTMLElement, context: PresentationContext): void {
    const application = new Application()
    this.application = application
    this.ready = application
      .init({
        width: this.options.width,
        height: this.options.height,
        background: this.options.background ?? 0x000000,
        antialias: this.options.antialias ?? true,
        resolution: Math.min(
          context.devicePixelRatio || 1,
          this.options.maxPixelRatio ?? 2,
        ),
        autoDensity: true,
        // The host owns the clock. PIXI never steps anything on its own.
        autoStart: false,
      })
      .then(() => {
        container.appendChild(application.canvas)
        application.canvas.style.display = "block"
        this.started = true
        this.options.onReady?.(application)
      })
  }

  /** Resolves when there is a renderer to draw with. */
  whenReady(): Promise<void> {
    return this.ready ?? Promise.resolve()
  }

  render(
    view: TView,
    previousView: TView | null,
    alpha: number,
    dtMs: number,
  ): void {
    const application = this.application
    if (application === null || !this.started) return
    this.options.draw(application.stage, { view, previousView, alpha, dtMs })
    // One draw call per host frame, and no ticker anywhere.
    application.render()
  }

  unmount(): void {
    this.application?.destroy(true, { children: true })
    this.application = null
    this.started = false
    this.ready = null
  }

  get app(): Application | null {
    return this.application
  }
}

export function createPixiPresentation<TView>(
  options: PixiPresentationOptions<TView>,
): PixiPresentation<TView> {
  return new PixiPresentation(options)
}

export { lerp, lerpAngle, NodeSet } from "@clockwork2/kernel"
export { Application, Container, Graphics, Text } from "pixi.js"
