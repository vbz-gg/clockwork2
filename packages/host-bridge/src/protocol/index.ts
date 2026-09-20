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
  Snapshot,
  TerminalReason,
  TickRate,
} from "@clockwork2/kernel"

export const PROTOCOL_VERSION = 1

export type HostToGame =
  | { readonly type: "hello"; readonly protocol: number }
  | {
      readonly type: "init"
      readonly seed: string
      readonly config: unknown
      readonly tickHz: TickRate
      readonly maxTicks: number
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
