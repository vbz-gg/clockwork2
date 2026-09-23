/**
 * The messages that cross the frame boundary.
 *
 * Two rules, both of them load-bearing.
 *
 * No message carries a URL, and the parent never navigates from one. The
 * handler is a table keyed by message type with no `navigate` row in it, so
 * adding one is a visible diff in a review rather than a line buried in a
 * switch.
 *
 * No message carries a token, a wallet, a balance, a price, HTML, a function
 * or another player's data. The frame is untrusted code from a submitter; it
 * gets a seed, a config and the player's own input, and it hands back a
 * result.
 */

import type {
  Counters,
  InputEvent,
  Snapshot,
  TerminalReason,
  TickRate,
} from "../../index.js"

export const PROTOCOL_VERSION = 1

/**
 * What the frame reports when the conversation itself goes wrong.
 *
 * These are the protocol's codes, not the kernel's `ERROR_CODES`. They say
 * something about the exchange between a host and a frame rather than about
 * anything a simulation did, which is why the skill's failure-modes reference
 * does not carry them: a game author can do nothing about any of them.
 */
export const FRAME_ERRORS = {
  /** `start` arrived before `init`, so there is no session to start. */
  NOT_INITIALISED: "E_FRAME_NOT_INITIALISED",
  /** A second `init` arrived. A frame runs one session and is then done. */
  ALREADY_INITIALISED: "E_FRAME_ALREADY_INITIALISED",
  /** Building the session from `init` threw. */
  INIT_FAILED: "E_FRAME_INIT_FAILED",
  /** A second `start` arrived. One session is started once. */
  ALREADY_STARTED: "E_FRAME_ALREADY_STARTED",
  /** The loop threw while running the player's own inputs. */
  THREW: "E_FRAME_THREW",
} as const

export type HostToGame =
  | { readonly type: "hello"; readonly protocol: number }
  | {
      readonly type: "init"
      readonly seed: string
      readonly config: unknown
      readonly tickHz: TickRate
      readonly maxTicks: number
      /**
       * A recorded log, which makes this session a replay rather than a run.
       *
       * The same loop plays it: a replay is not a second code path, it is a
       * session whose inputs come from a log instead of from devices. Left
       * out, the frame captures from real events as it always has.
       *
       * It is the one field here that could be mistaken for a way to feed a
       * player's inputs into their own live run, so the frame refuses to
       * capture device input for a session that carries one. A replay reads
       * its log and nothing else.
       */
      readonly inputs?: readonly InputEvent[]
      /**
       * How fast a replay advances. Only with `inputs`.
       *
       * A live session may never carry one. Speed on a live run is a player
       * slowing the game down to play it, which is the reason a frame does
       * not expose `setSpeed` at all, and the frame refuses an `init` that
       * asks for one without a log to replay.
       */
      readonly speed?: number
    }
  | { readonly type: "start" }
  | { readonly type: "pause" }
  | { readonly type: "resume" }
  | { readonly type: "end" }
  | {
      readonly type: "resize"
      readonly width: number
      readonly height: number
      readonly devicePixelRatio: number
    }
  | { readonly type: "theme"; readonly theme: string }
  | {
      /** A host-drawn on-screen control. The only source of virtual inputs. */
      readonly type: "virtual-input"
      readonly action: string
      readonly value: number
    }

export type GameToHost =
  | {
      readonly type: "ready"
      readonly protocol: number
      readonly manifestHash: string
      readonly kernelVersion: string
    }
  | { readonly type: "started" }
  | {
      readonly type: "progress"
      readonly tick: number
      readonly counters: Counters
    }
  | {
      readonly type: "checkpoint"
      readonly tick: number
      readonly hash: string
    }
  | {
      readonly type: "ended"
      readonly tick: number
      readonly counters: Counters
      readonly reason: TerminalReason
      readonly finalSnapshot: Snapshot
    }
  | {
      /**
       * A slice of the input log, sent while the run is still going.
       *
       * `ended` carries the whole recording, but it arrives once the player
       * knows how they did. These arrive before that, so a host can keep what
       * the log looked like at a moment it stamped itself. A submitted log
       * whose past disagrees with a slice already sent is one the host can
       * refuse without replaying anything.
       */
      readonly type: "log-chunk"
      /** Where this slice starts in the whole log. */
      readonly fromIndex: number
      readonly inputs: readonly InputEvent[]
    }
  | {
      readonly type: "recording-chunk"
      readonly index: number
      readonly total: number
      readonly data: string
    }
  | { readonly type: "error"; readonly code: string; readonly detail: string }
  | { readonly type: "heartbeat"; readonly tick: number }

export type MessageType<T extends { readonly type: string }> = T["type"]

/** A handler for each message type, and nothing else. */
export type HandlerTable<T extends { readonly type: string }> = {
  readonly [K in MessageType<T>]: (message: Extract<T, { type: K }>) => void
}

/**
 * Builds a dispatcher from a complete table.
 *
 * An unknown type is dropped rather than thrown on: a frame is untrusted, and
 * a message it invents must not be able to stop the host.
 */
export function createDispatcher<T extends { readonly type: string }>(
  table: HandlerTable<T>,
): (message: unknown) => boolean {
  return (message: unknown): boolean => {
    if (message === null || typeof message !== "object") return false
    const type = (message as { type?: unknown }).type
    if (typeof type !== "string") return false
    const handler = (
      table as Record<string, ((m: unknown) => void) | undefined>
    )[type]
    if (handler === undefined) return false
    handler(message)
    return true
  }
}

/** At most this often, so a frame cannot flood the host with progress. */
export const PROGRESS_INTERVAL_MS = 250

/**
 * At most this often for a slice of the input log.
 *
 * Slower than progress because a slice is bigger and its job is evidence
 * rather than a live number: what matters is that the host holds part of the
 * log before the run is over, not how finely it is cut.
 */
export const LOG_CHUNK_INTERVAL_MS = 2000
