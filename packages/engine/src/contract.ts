/**
 * The contract between a game, the host that runs it in a browser, and the
 * validator that replays it on a server.
 *
 * The shape of it carries two decisions worth stating plainly.
 *
 * `tick()` takes no delta. A fixed step is what makes the simulation
 * independent of the player's frame rate, and the surest way to keep it that
 * way is to give the game nothing to integrate against.
 *
 * Inputs are the game's own. A manifest declares each input by name and
 * range, the game's page records what its player did as those inputs, and
 * the simulation reads them in `tick`. What a server trusts is the replay of
 * the recorded inputs, and `checkInputs`, which refuses any input the
 * manifest does not declare. A game that decided in its drawing code that a
 * tap hit a target, and recorded only the answer, would replay perfectly and
 * still have decided the result where nothing checks it, so the guidance is
 * to record the tap and decide in `tick`.
 */

import type { PackReader } from "./packs.js"

/** A value with an exact canonical encoding. Anything else is refused. */
export type PlainValue =
  | string
  | number
  | boolean
  | null
  | readonly PlainValue[]
  | { readonly [key: string]: PlainValue }

/** A plain-data copy of simulation state: hashable, storable, restorable. */
export type Snapshot = { readonly [key: string]: PlainValue }

/** Declared counters. Every value is an integer. */
export type Counters = Readonly<Record<string, number>>

/**
 * One input, stamped with the tick it applies to.
 *
 * The tick is the tick the simulation is *about to* run, not the tick of
 * whichever update happened to drain the queue. Clockwork 1 stamped at drain
 * time, so the same keystroke landed on a different tick depending on the
 * frame rate.
 *
 * There is no device: each game declares its own inputs, by name and range,
 * and decides what to record. `value` is a whole number in that range.
 */
export type InputEvent = {
  readonly tick: number
  /** The name of an input the manifest declares. */
  readonly code: string
  readonly value: number
}

/**
 * A cue for the host: a sound to play, a rumble, a camera shake. Produced by
 * the last tick and drained by the host.
 *
 * Effects exist so that nothing observable happens *inside* `tick`. A headless
 * replay then has nothing to stub, and a sound cannot be played twice because
 * a frame ran two steps.
 */
export type Effect = {
  readonly type: string
  readonly data?: PlainValue
}

/** How a session ended. Written by the kernel, never by the game. */
export const TERMINAL_REASONS = [
  "completed",
  "died",
  "timeout",
  "abandoned",
  "error",
] as const

export type TerminalReason = (typeof TERMINAL_REASONS)[number]

/**
 * What a game implements.
 *
 * `init` and `tick` run under the kernel's shims, so anything they touch that
 * is not exactly specified throws at the point of use.
 */
export interface GameModule<TView = unknown, TConfig = PlainValue> {
  /** Validated by the platform without running the game. */
  readonly manifest: unknown

  /**
   * Deterministic setup. No I/O, no clock, no network.
   *
   * `packs` reads the data packs the manifest declares. Start packs can be
   * read here, in `restore` and in every tick; a demand pack only in a tick
   * that `packsNeeded()` named it for. Keep the reader: a `restore` that
   * calls `init` again has to hand it back.
   */
  init(seed: string, config: TConfig, packs: PackReader): void

  /** Advance exactly one tick. The only writer of simulation state. */
  tick(inputs: readonly InputEvent[]): void

  /**
   * What the renderer reads. May be a live reference when the renderer shares
   * a thread with the simulation, so a renderer must treat it as read-only.
   * It must be structured-cloneable, because in worker mode it is cloned.
   */
  view(): TView

  /** A plain-data copy, for hashing, restore and submission. */
  snapshot(): Snapshot

  /**
   * Rebuild state from a snapshot. Restoring at tick N and continuing must
   * reach the same state as never having stopped, PRNG position included.
   */
  restore(snapshot: Snapshot): void

  /** The declared counters, as integers. */
  score(): Counters

  /** True once, and never false again. */
  isOver(): boolean

  /** Cues from the last tick. The host drains this; calling it clears it. */
  effects(): readonly Effect[]

  /**
   * The demand packs the next tick will read, as a pure function of state.
   *
   * The kernel calls it once after `init`, once after `restore`, and once
   * after every tick, and the answer decides what the next tick may read. A
   * host that lacks one of the named packs holds the loop until it arrives,
   * so the step that reads it is the same step everywhere. Naming a start
   * pack is allowed and changes nothing. Leave it out when the game has no
   * demand packs.
   */
  packsNeeded?(): readonly string[]
}

/**
 * A bundle's default export. A factory is allowed because one process running
 * many sessions needs many instances; the platform still evaluates the module
 * afresh per session, since a fresh instance does not reset a module-level
 * counter.
 */
export type GameModuleSource<TView = unknown, TConfig = PlainValue> =
  | GameModule<TView, TConfig>
  | (() => GameModule<TView, TConfig>)

/** Normalises the two allowed shapes of a default export. */
export function instantiate<TView, TConfig>(
  source: GameModuleSource<TView, TConfig>,
): GameModule<TView, TConfig> {
  return typeof source === "function" ? source() : source
}

/** What the host hands a presentation when it mounts. */
export interface PresentationContext {
  /**
   * Randomness for the renderer. Never seeded from the session, so that
   * consuming it cannot move the simulation's stream, and a purely visual
   * flourish cannot change the result.
   */
  readonly random: () => number
  readonly assets: ReadonlyMap<string, ArrayBuffer | string>
  readonly devicePixelRatio: number
  readonly theme: string
}

/**
 * What a renderer implements. It reads and never writes. `TContainer` is
 * generic so the kernel stays free of DOM types; an adapter narrows it.
 */
export interface Presentation<TView = unknown, TContainer = unknown> {
  mount(container: TContainer, context: PresentationContext): void

  /**
   * Gets ready to draw, for a renderer that starts asynchronously: workers to
   * spawn, a WebAssembly core to compile, shaders to build, a device to ask
   * for. The host calls it once, after `mount` and before the first tick, and
   * starts the session's clock only when it resolves, so no tick runs and no
   * input is recorded while nothing can be drawn. A rejection means the
   * presentation cannot draw on this device: the host reports it as
   * `E_PRESENTATION_FAILED`, carrying this error's message, and the session
   * never starts. Leave it out when `mount` leaves the presentation ready.
   */
  prepare?(container: TContainer, context: PresentationContext): Promise<void>

  /**
   * @param view the current simulation view
   * @param previousView the view one tick earlier, or null on the first frame
   * @param alpha how far between them this frame sits, in [0, 1)
   * @param dtMs real milliseconds since the previous frame, for effects that
   *   are allowed to be frame-dependent because nothing reads them back
   */
  render(
    view: TView,
    previousView: TView | null,
    alpha: number,
    dtMs: number,
  ): void

  unmount(): void
}
