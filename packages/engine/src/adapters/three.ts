/**
 * @clockwork2/adapter-three
 *
 * A read-only presentation on Three.js.
 *
 * Three's own animation loop is never started. The host calls `render`, the
 * game updates its objects from the view, and the adapter calls
 * `renderer.render(scene, camera)` once. The simulation never touches an
 * Object3D, and Three's math helpers never touch the simulation: `Quaternion`
 * and `Euler` call `Math.sin` and `Math.cos`, and `Clock` reads
 * `performance.now`, so all three are fine here and banned on the other side
 * of the boundary.
 */

import { PerspectiveCamera, Scene, WebGLRenderer } from "three"
import type { Presentation, PresentationContext } from ".."

export type ThreeDraw<TView> = (
  context: {
    readonly scene: Scene
    readonly camera: PerspectiveCamera
    readonly renderer: WebGLRenderer
  },
  frame: {
    readonly view: TView
    readonly previousView: TView | null
    readonly alpha: number
    readonly dtMs: number
  },
) => void

export interface ThreePresentationOptions<TView> {
  readonly width: number
  readonly height: number
  readonly draw: ThreeDraw<TView>
  readonly antialias?: boolean
  readonly maxPixelRatio?: number
  readonly fieldOfView?: number
  readonly near?: number
  readonly far?: number
  readonly onReady?: (context: {
    scene: Scene
    camera: PerspectiveCamera
    renderer: WebGLRenderer
  }) => void
}

export class ThreePresentation<TView>
  implements Presentation<TView, HTMLElement>
{
  private renderer: WebGLRenderer | null = null
  private scene: Scene | null = null
  private camera: PerspectiveCamera | null = null

  constructor(private readonly options: ThreePresentationOptions<TView>) {}

  mount(container: HTMLElement, context: PresentationContext): void {
    const renderer = new WebGLRenderer({
      antialias: this.options.antialias ?? true,
    })
    renderer.setPixelRatio(
      Math.min(context.devicePixelRatio || 1, this.options.maxPixelRatio ?? 2),
    )
    renderer.setSize(this.options.width, this.options.height, false)
    renderer.domElement.style.display = "block"
    renderer.domElement.style.width = "100%"
    renderer.domElement.style.height = "100%"
    container.appendChild(renderer.domElement)

    const scene = new Scene()
    const camera = new PerspectiveCamera(
      this.options.fieldOfView ?? 60,
      this.options.width / this.options.height,
      this.options.near ?? 0.1,
      this.options.far ?? 2000,
    )
    this.renderer = renderer
    this.scene = scene
    this.camera = camera
    this.options.onReady?.({ scene, camera, renderer })
  }

  render(
    view: TView,
    previousView: TView | null,
    alpha: number,
    dtMs: number,
  ): void {
    const { renderer, scene, camera } = this
    if (renderer === null || scene === null || camera === null) return
    this.options.draw(
      { scene, camera, renderer },
      { view, previousView, alpha, dtMs },
    )
    renderer.render(scene, camera)
  }

  resize(width: number, height: number): void {
    const { renderer, camera } = this
    if (renderer === null || camera === null) return
    renderer.setSize(width, height, false)
    camera.aspect = width / height
    camera.updateProjectionMatrix()
  }

  unmount(): void {
    this.renderer?.domElement.remove()
    this.renderer?.dispose()
    this.renderer = null
    this.scene = null
    this.camera = null
  }
}

export function createThreePresentation<TView>(
  options: ThreePresentationOptions<TView>,
): ThreePresentation<TView> {
  return new ThreePresentation(options)
}

export { lerp, lerpAngle, NodeSet } from ".."
