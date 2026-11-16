/**
 * The manifest: a JSON document the platform validates without running the
 * game.
 *
 * It replaces the pile that Clockwork 1 and game-base spread across code -
 * `createGameModule`, `getGameModuleConfig`, `customOperators`,
 * `objectiveDefinitions`, the meta-config schema, `getInputMapping`,
 * `getVersion` and `requiredForValidation`. All of those needed the bundle to
 * be executed before anything could be known about it, which is the wrong way
 * round for a platform deciding whether to run untrusted code.
 */

import type { PlainValue } from "../contract.js"
import type { CounterDeclaration, TiePolicy } from "../counters.js"

export const TICK_RATES = [30, 60, 120] as const
export type TickRate = (typeof TICK_RATES)[number]

/**
 * One device code an action listens to. Which device that is, and what values
 * it carries, is read from the code (`input-codes.ts`), so a binding cannot
 * say one thing and do another.
 */
export type InputBinding = {
  /** A device code: "ArrowUp", "pointer0", "gamepad0-axis1", "tilt-x". */
  readonly code: string
  /** Shown to the player on a controls card. */
  readonly label?: string
}

/**
 * What a game records: each action and the device codes that drive it.
 *
 * Only a bound code is recorded, so each game decides what its recording
 * holds, and a server refuses any input outside it. A game draws its own
 * on-screen controls and decides in `tick` what a pointer hit, from
 * positions measured in `viewport` units.
 */
export type Inputs = {
  readonly map: { readonly [action: string]: readonly InputBinding[] }
  /**
   * The units a pointer's position is measured in: 0 to `width` across the
   * element the game is drawn on, 0 to `height` down it. Required when a
   * pointer coordinate is bound, so the hit test in `tick`, the host that
   * measures a touch, and a server checking the log all use one space.
   */
  readonly viewport?: { readonly width: number; readonly height: number }
}

export type ParamBase = {
  readonly label: string
  readonly description?: string
  readonly optional?: boolean
}

export type ColorParam = ParamBase & {
  readonly type: "color"
  readonly default?: string
  readonly allowed?: readonly string[]
}

export type StringParam = ParamBase & {
  readonly type: "string"
  readonly default?: string
  readonly allowed?: readonly string[]
  readonly minLength?: number
  readonly maxLength?: number
  /** Anchored at both ends when it runs, and capped in length. */
  readonly pattern?: string
}

export type EnumParam = ParamBase & {
  readonly type: "enum"
  readonly values: readonly string[]
  readonly default?: string
}

export type IntParam = ParamBase & {
  readonly type: "int"
  readonly min?: number
  readonly max?: number
  readonly default?: number
}

export type BoolParam = ParamBase & {
  readonly type: "bool"
  readonly default?: boolean
}

export type ParamDefinition =
  | ColorParam
  | StringParam
  | EnumParam
  | IntParam
  | BoolParam

export type ParamSchema = { readonly [name: string]: ParamDefinition }
export type ParamValues = { readonly [name: string]: string | number | boolean }

export type AssetDeclaration = {
  readonly path: string
  readonly sha256: string
  readonly bytes: number
  /**
   * True when the simulation reads it, so the validator fetches it. A texture
   * is false; a level layout the simulation walks is true.
   */
  readonly requiredForSim: boolean
  /**
   * When a pack the simulation reads must arrive. Only meaningful with
   * `requiredForSim: true`, and refused otherwise.
   *
   * `"start"`, the default, arrives before `init` and can be read from `init`,
   * `restore` and every tick. `"demand"` arrives when the game's
   * `packsNeeded()` names it, and can be read only in the ticks that follow
   * such a call.
   */
  readonly load?: "start" | "demand"
  readonly license: string
  readonly generator?: string
}

export type Budgets = {
  readonly bundleBytes?: number
  readonly assetBytes?: number
  readonly microsecondsPerTick?: number
}

export type Display = {
  readonly orientation?: "any" | "portrait" | "landscape"
  readonly minViewport?: { readonly width: number; readonly height: number }
  readonly aspect?: string
}

export type Capabilities = {
  /** Always true. A manifest that says otherwise is refused. */
  readonly deterministic: true
  readonly physics: "none" | string
  readonly renderer: "canvas2d" | "pixi" | "three" | "dom" | string
  /** Always false in the first release. */
  readonly multiplayer: false
  readonly webgpu?: boolean
  /** Needed to bind `mouse-dx` or `mouse-dy`: the host locks the mouse to the game. */
  readonly pointerLock?: boolean
}

export type Session = {
  readonly tickHz: TickRate
  /** The hard cap. The kernel ends the run here whatever the game says. */
  readonly maxTicks: number
  readonly maxWallSeconds: number
  /** False for an endless game, which must still be bounded by maxTicks. */
  readonly hasEnding: boolean
}

export type Manifest = {
  /** 2 since bindings lost `device` and `inputs.controls` was removed. */
  readonly schemaVersion: 2
  /** Immutable across every version of the game. */
  readonly id: string
  /** Strictly increasing. */
  readonly version: string
  readonly name: string
  readonly kernel: { readonly version: string }
  readonly genres?: readonly string[]
  readonly session: Session
  readonly inputs: Inputs
  readonly counters: readonly CounterDeclaration[]
  readonly rankBy: readonly string[]
  readonly tiePolicy: TiePolicy
  readonly params?: ParamSchema
  readonly assets?: readonly AssetDeclaration[]
  readonly budgets?: Budgets
  readonly display?: Display
  readonly capabilities: Capabilities
}

type AssertPlain<T extends PlainValue> = T
export type ManifestIsPlain = AssertPlain<Manifest>
