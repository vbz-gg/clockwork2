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
 * One input a game records: a name, and the whole numbers it can carry.
 *
 * A press is an input from 0 to 1. A position, a stick or a tilt is a range
 * the game chooses, and the coarsest range the game needs is the one to
 * declare, because every value a reading passes through is an input to
 * record.
 */
export type InputDeclaration = {
  readonly min: number
  readonly max: number
  /** Shown to the player on a controls card. */
  readonly label?: string
}

/**
 * Every input a game records, by name. Only these are recorded, and a server
 * refuses a log holding anything else, so each game decides what its
 * recording holds.
 */
export type Inputs = { readonly [name: string]: InputDeclaration }

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
  readonly pointerLock?: boolean
}

export type Session = {
  readonly tickHz: TickRate
  /**
   * Whether the game ends by itself: true for one with a time limit, a life
   * count or a difficulty that eventually wins, false for one that runs
   * until the player stops. It describes the game, for a reader of the
   * manifest, and nothing in the engine reads or checks it: no session has a
   * step limit, and the conformance checks play each log to its end or to
   * `CHECK_WINDOW_TICKS` whatever it says.
   */
  readonly hasEnding: boolean
}

/**
 * How a ranked run is ordered, declared together or not at all.
 *
 * `rankBy` names declared counters, most significant first, and `tiePolicy`
 * says what an exact tie is. A platform that ranks runs requires both, and
 * the conformance suite's ranked set checks for them. A game played only on
 * its own page needs neither.
 */
export type Ranking =
  | { readonly rankBy: readonly string[]; readonly tiePolicy: TiePolicy }
  | { readonly rankBy?: never; readonly tiePolicy?: never }

/** The format this kernel reads. A manifest at any other is refused. */
export const MANIFEST_FORMAT = 3

export type Manifest = {
  /**
   * The manifest's format. 3 since no run has a step limit: format 3 has no
   * `session.maxTicks`, `session.maxWallSeconds` or `budgets.bundleBytes`,
   * and `rankBy` and `tiePolicy` are optional. Format 2 was the first to
   * declare the game's own inputs rather than binding devices.
   */
  readonly schemaVersion: typeof MANIFEST_FORMAT
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
  readonly params?: ParamSchema
  readonly assets?: readonly AssetDeclaration[]
  readonly budgets?: Budgets
  readonly display?: Display
  readonly capabilities: Capabilities
} & Ranking

type AssertPlain<T extends PlainValue> = T
export type ManifestIsPlain = AssertPlain<Manifest>
