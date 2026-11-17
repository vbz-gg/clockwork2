/**
 * The renderer. It reads the view and writes nothing.
 *
 * `alpha` is how far this frame sits between the last tick and the next, in
 * [0, 1). Interpolating with it is what makes a 60 Hz simulation look smooth
 * on a 144 Hz display; ignoring it makes the game look like it is running at
 * the tick rate. It is the only legitimate use of real time in a game.
 *
 * Everything the simulation may not touch is fine here: `Math.random` for a
 * purely visual flourish, `Math.sin`, `performance.now`. Nothing in this file
 * is read back by the simulation, so nothing in it can change a score.
 */

import { Canvas2dPresentation } from "@clockwork2/engine/adapter-canvas2d"
import { LANES, TRACK_LENGTH, type View } from "./sim"

const WIDTH = 480
const HEIGHT = 720

function laneX(lane: number): number {
  return ((lane + 0.5) / LANES) * WIDTH
}

/** Straight-line interpolation between the two views this frame sits between. */
function depth(
  z: number,
  previousZ: number | undefined,
  alpha: number,
): number {
  return previousZ === undefined ? z : previousZ + (z - previousZ) * alpha
}

export function createPresentation(): Canvas2dPresentation<View> {
  return new Canvas2dPresentation<View>({
    width: WIDTH,
    height: HEIGHT,
    background: "#0b1020",
    draw: (context, { view, previousView, alpha }) => {
      const previousRocks = new Map(
        (previousView?.rocks ?? []).map((rock) => [rock.id, rock.z]),
      )
      const previousMotes = new Map(
        (previousView?.motes ?? []).map((mote) => [mote.id, mote.z]),
      )

      context.strokeStyle = "#1b2a4a"
      context.lineWidth = 2
      for (let lane = 1; lane < LANES; lane++) {
        const x = (lane / LANES) * WIDTH
        context.beginPath()
        context.moveTo(x, 0)
        context.lineTo(x, HEIGHT)
        context.stroke()
      }

      for (const mote of view.motes) {
        const z = depth(mote.z, previousMotes.get(mote.id), alpha)
        const y = HEIGHT - (z / TRACK_LENGTH) * HEIGHT
        context.fillStyle = "#6ee7ff"
        context.beginPath()
        context.arc(laneX(mote.lane), y, 7, 0, Math.PI * 2)
        context.fill()
      }

      for (const rock of view.rocks) {
        const z = depth(rock.z, previousRocks.get(rock.id), alpha)
        const y = HEIGHT - (z / TRACK_LENGTH) * HEIGHT
        context.fillStyle = "#e05263"
        context.fillRect(laneX(rock.lane) - 16, y - 16, 32, 32)
      }

      context.save()
      context.translate(laneX(view.lane), HEIGHT - 70)
      context.rotate(view.sway * 0.12)
      context.fillStyle = view.over ? "#6b7280" : "#f3f4f6"
      context.beginPath()
      context.moveTo(0, -22)
      context.lineTo(16, 18)
      context.lineTo(-16, 18)
      context.closePath()
      context.fill()
      context.restore()

      context.fillStyle = "#e5e7eb"
      context.font = "16px system-ui, sans-serif"
      context.fillText(`motes ${view.motesTaken}`, 16, 28)
    },
  })
}
