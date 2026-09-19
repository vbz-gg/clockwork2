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
 * Input events are built by the host from device events, never by the game. A
 * game that could construct its own input could do its hit-testing in the
 * renderer and feed the answer to the simulation as a virtual press. That
 * replays perfectly and still decides the score on the client, which is the
 * one failure a conformance suite cannot see.
 */

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

/** The devices a host may build an input from. */
export const INPUT_DEVICES = [
  "key",
  "pointer",
  "touch",
  "gamepad",
  "virtual",
] as const

export type InputDevice = (typeof INPUT_DEVICES)[number]

/**
 * One input, stamped with the tick it applies to.
 *
 * The tick is the tick the simulation is *about to* run, not the tick of
 * whichever update happened to drain the queue. Clockwork 1 stamped at drain
 * time, so the same keystroke landed on a different tick depending on the
 * frame rate.
 *
 * `value` is an integer. Analog sources are quantised by the host, with the
 * deadzones in `inputs.ts`, before the simulation ever sees them.
 */
export interface InputEvent {
  readonly tick: number
  readonly device: InputDevice
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
export interface Effect {
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

  /** Deterministic setup. No I/O, no clock, no network. */
  init(seed: string, config: TConfig): void

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
