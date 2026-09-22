/**
 * The renderer. It reads the view and writes nothing.
 *
 * Three's own animation loop is never started: the host decides when a frame
 * happens, this updates the scene from the view, and the adapter renders once.
 * Three's `Quaternion`, `Euler` and `Clock` all call `Math.sin`, `Math.cos` or
 * `performance.now`, which is exactly why they are fine on this side of the
 * boundary and banned on the other.
 *
 * Objects are kept in a map keyed by the simulation's own ids, created on
 * first sight and removed when the view stops mentioning them. Rebuilding the
 * scene every frame would work and would be slow.
 */

import { NodeSet, ThreePresentation } from "@clockwork2/engine/adapter-three"
import {
  BoxGeometry,
  ConeGeometry,
  DirectionalLight,
  HemisphereLight,
  Mesh,
  MeshStandardMaterial,
  type Object3D,
  type Scene,
  SphereGeometry,
} from "three"
import { LANES, type View } from "./sim"

const WIDTH = 480
const HEIGHT = 720
const LANE_SPACING = 2.4

const ROCK = new BoxGeometry(1.6, 1.6, 1.6)
const MOTE = new SphereGeometry(0.5, 16, 12)
const SHIP = new ConeGeometry(0.8, 2, 8)
const ROCK_MATERIAL = new MeshStandardMaterial({ color: 0xe05263 })
const MOTE_MATERIAL = new MeshStandardMaterial({
  color: 0x6ee7ff,
  emissive: 0x1b6f80,
})
const SHIP_MATERIAL = new MeshStandardMaterial({ color: 0xf3f4f6 })

function laneX(lane: number): number {
  return (lane - (LANES - 1) / 2) * LANE_SPACING
}

function depth(
  z: number,
  previousZ: number | undefined,
  alpha: number,
): number {
  return previousZ === undefined ? z : previousZ + (z - previousZ) * alpha
}

export function createPresentation(): ThreePresentation<View> {
  // One node per simulation id, created on first sight and removed when the
  // view stops mentioning it. Rebuilding the scene every frame would work and
  // would be slow.
  let rocks: NodeSet<{ id: number; lane: number; z: number }, Object3D> | null =
    null
  let motes: NodeSet<{ id: number; lane: number; z: number }, Object3D> | null =
    null
  let ship: Mesh | null = null
  let alphaNow = 0
  let previousZ = new Map<number, number>()

  const nodesFor = (
    scene: Scene,
    geometry: BoxGeometry | SphereGeometry,
    material: MeshStandardMaterial,
  ) =>
    new NodeSet<{ id: number; lane: number; z: number }, Object3D>({
      id: (item) => String(item.id),
      create: () => {
        const node = new Mesh(geometry, material)
        scene.add(node)
        return node
      },
      update: (node, item) => {
        node.position.set(
          laneX(item.lane),
          0,
          depth(item.z, previousZ.get(item.id), alphaNow),
        )
      },
      destroy: (node) => {
        scene.remove(node)
      },
    })

  return new ThreePresentation<View>({
    width: WIDTH,
    height: HEIGHT,
    fieldOfView: 55,
    onReady: ({ scene, camera }) => {
      scene.add(new HemisphereLight(0x8fb7ff, 0x0b1020, 1.1))
      const sun = new DirectionalLight(0xffffff, 1.4)
      sun.position.set(3, 8, 6)
      scene.add(sun)
      ship = new Mesh(SHIP, SHIP_MATERIAL)
      ship.rotation.x = Math.PI / 2
      scene.add(ship)
      camera.position.set(0, 4.2, -8)
      camera.lookAt(0, 0, 10)
      rocks = nodesFor(scene, ROCK, ROCK_MATERIAL)
      motes = nodesFor(scene, MOTE, MOTE_MATERIAL)
    },
    draw: (_context, { view, previousView, alpha }) => {
      alphaNow = alpha
      previousZ = new Map<number, number>()
      for (const rock of previousView?.rocks ?? [])
        previousZ.set(rock.id, rock.z)
      for (const mote of previousView?.motes ?? [])
        previousZ.set(mote.id, mote.z)

      rocks?.sync(view.rocks)
      motes?.sync(view.motes)

      if (ship !== null) {
        ship.position.set(laneX(view.lane), 0, 0)
        ship.rotation.z = view.sway * 0.2
        SHIP_MATERIAL.color.setHex(view.over ? 0x6b7280 : 0xf3f4f6)
      }
    },
  })
}
