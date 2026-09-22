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

import { Application, type Container } from "pixi.js"
import type { Presentation, PresentationContext } from ".."

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
  /**
   * Bumped on every mount and unmount.
   *
   * `Application.init()` is asynchronous, and a host that starts a new session
   * unmounts this one while PIXI may still be starting up. Without a way to
   * tell whether a late `init` callback still belongs to the presentation the
   * host is using, that callback appends the canvas of an abandoned
   * application to the stage and marks it started - and the next frame then
   * renders through a destroyed renderer.
   */
  private generation = 0

  constructor(private readonly options: PixiPresentationOptions<TView>) {}

  mount(container: HTMLElement, context: PresentationContext): void {
    const generation = ++this.generation
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
        // Unmounted while PIXI was starting. Nothing here may touch the
        // container or `started`; `unmount` destroys the application once
        // this promise settles.
        if (this.generation !== generation) return
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
    this.generation++
    const application = this.application
    const ready = this.ready
    this.application = null
    this.ready = null
    this.started = false
    if (application === null) return
    if (ready === null) {
      application.destroy(true, { children: true })
      return
    }
    // Destroying an application that is still initialising leaves its canvas
    // and its WebGL context behind, and a browser only grants so many of
    // those before the next one fails. So the destroy waits for init to
    // settle - which it does whether init resolved or threw.
    void ready
      .catch(() => undefined)
      .then(() => {
        application.destroy(true, { children: true })
      })
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

export { Application, Container, Graphics, Text } from "pixi.js"
export { lerp, lerpAngle, NodeSet } from ".."
