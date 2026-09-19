/**
 * @clockwork2/compat-clockwork1
 *
 * The parts of Clockwork 1 a ported game leans on, as an ordinary library
 * rather than as engine machinery. Nothing here is required: a Clockwork 2
 * game can implement `tick()` with plain arrays and numbers. It exists so a
 * port is a port rather than a rewrite.
 *
 * What is deliberately absent: the engine that owned these, the hidden update
 * pass, the platform layer, the asset loader, and the renderer base class.
 */

export {
  CollisionGrid,
  type Occupant,
} from "./collision-grid"
export {
  GameObject,
  GameObjectGroup,
  type SerializedGameObject,
} from "./game-object"
export {
  circleOverlapsRectangle,
  futurePosition,
  lineIntersectsRectangle,
  linesIntersect,
  type Rectangle,
  rectanglesOverlap,
  turnTowards,
} from "./geometry"
export { Vector2D } from "./vector"
