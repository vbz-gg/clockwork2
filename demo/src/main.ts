/**
 * The demo, wired together.
 *
 * Everything the host needs is here and nothing else: a module, a manifest, a
 * presentation, and somewhere to put it. The loop, the input capture and the
 * recording come from @clockwork2/host-bridge; the game knows nothing about
 * any of them.
 */

import { AudioSink, GameHost, InputCapture } from "@clockwork2/host-bridge"
import {
  decodeRecording,
  encodeRecording,
  hashCanonical,
  RecordedInputSource,
  type Recording,
} from "@clockwork2/kernel"
import {
  createGame,
  DEFAULT_CONFIG,
  MANIFEST,
  type SnakeConfig,
  type SnakeView,
} from "./game/index"
import { createSnakePresentation } from "./present/pixi"
import { SOUNDS } from "./present/sounds"
import { Ui, type UiAction } from "./ui"

const container = document.querySelector("#app") as HTMLElement
let host: GameHost<SnakeView, HTMLElement, SnakeConfig> | null = null
let capture: InputCapture | null = null
let mode: "playing" | "replaying" | "idle" = "idle"
let lastRecording: Recording | null = null
let recordedFinalHash: string | null = null
let frames = 0
let framesAt = performance.now()
let fps = 0
/**
 * Called after every session, by whatever created it.
 *
 * Only the test hooks set it, and only in a build that has them. Without it
 * they stay bound to the host they were installed against, so a spec that
 * clicks New game or Replay and then reads the hooks is reading the session
 * before last - which looks exactly like a page that stopped simulating.
 */
let afterNewSession: (() => void) | null = null

const audio = new AudioSink({ sounds: SOUNDS })
const ui = new Ui(container, (action) => {
  handle(action)
})

function newSession(
  seed: string,
  options: { readonly replay?: Recording } = {},
): void {
  host?.destroy()
  capture?.detach()

  const replay = options.replay
  const presentation = createSnakePresentation()
  host = new GameHost<SnakeView, HTMLElement, SnakeConfig>({
    module: createGame(),
    manifest: MANIFEST,
    seed: replay?.seed ?? seed,
    config: (replay?.config as SnakeConfig | undefined) ?? DEFAULT_CONFIG,
    presentation,
    container: ui.stage,
    checkpointEvery: 60,
    ...(replay === undefined
      ? {}
      : {
          inputs: new RecordedInputSource(replay.inputs),
          // A recording of a session the player stopped ends where they
          // stopped. Without this cap the replay carries on past that point
          // until the snake dies, reaches a different state, and the panel
          // reports a mismatch for a recording that never diverged.
          maxTicks: Math.max(replay.endTick, 1),
        }),
    onEffects: audio.handle,
    onEnded: (result) => {
      if (mode === "playing") {
        lastRecording = host?.recording() ?? null
        recordedFinalHash = hashCanonical(result.snapshot)
      }
      refresh()
    },
    presentationContext: {
      // The renderer's randomness is its own and is never seeded from the
      // session, so consuming it cannot move the simulation's stream.
      random: () => Math.random(),
      assets: new Map(),
      devicePixelRatio: globalThis.devicePixelRatio,
      theme: "dark",
    },
    onFrame: () => {
      frames++
      const now = performance.now()
      if (now - framesAt >= 500) {
        fps = (frames * 1000) / (now - framesAt)
        frames = 0
        framesAt = now
      }
      refresh()
    },
  })

  if (replay === undefined) {
    mode = "playing"
    recordedFinalHash = null
    capture = new InputCapture({
      manifest: MANIFEST,
      queue: host.live as never,
    })
    capture.attach()
  } else {
    mode = "replaying"
  }

  void audio.unlock()
  host.start()
  refresh()
  afterNewSession?.()
}

function handle(action: UiAction): void {
  switch (action.type) {
    case "new-game":
      newSession(action.seed)
      return
    case "stop":
      host?.stop()
      lastRecording = host?.recording() ?? lastRecording
      refresh()
      return
    case "replay": {
      const recording = lastRecording
      if (recording === null) return
      newSession(recording.seed, { replay: recording })
      return
    }
    case "pause":
      host?.pause()
      refresh()
      return
    case "resume":
      host?.resume()
      refresh()
      return
    case "speed":
      host?.setSpeed(action.value)
      return
    case "download": {
      const recording = lastRecording ?? host?.recording()
      if (recording === undefined || recording === null) return
      const blob = new Blob([encodeRecording(recording)], {
        type: "application/json",
      })
      const link = document.createElement("a")
      link.href = URL.createObjectURL(blob)
      link.download = `${recording.gameId}-${recording.seed}.json`
      link.click()
      URL.revokeObjectURL(link.href)
      return
    }
    default: {
      try {
        lastRecording = decodeRecording(action.text)
        recordedFinalHash = null
        newSession(lastRecording.seed, { replay: lastRecording })
      } catch (error) {
        console.error("that recording could not be read:", error)
      }
    }
  }
}

function refresh(): void {
  const counters = host?.counters() ?? {}
  ui.update({
    status: host?.status ?? "idle",
    tick: host?.tick ?? 0,
    apples: (counters.applesEaten as number) ?? 0,
    target: DEFAULT_CONFIG.targetApples,
    length: (counters.length as number) ?? 0,
    fps,
    mode,
    lastHash: host === null ? "-" : hashCanonical(host.snapshot()),
    recordedHash: mode === "replaying" ? recordedFinalHash : null,
    seed: ui.seed,
  })
  ui.setEnabled("replay", lastRecording !== null)
  ui.setEnabled("download", lastRecording !== null)
  ui.setEnabled("pause", host?.status === "running")
  ui.setEnabled("resume", host?.status === "paused")
  ui.setEnabled("stop", host?.status === "running" || host?.status === "paused")
}

newSession("demo-1")

// Dropped entirely from a production build: the flag is replaced at build
// time, so the dynamic import below is dead code and the module and its chunk
// disappear. scripts/check-no-test-hooks.ts proves that rather than assuming.
if (import.meta.env.DEV || import.meta.env.VITE_CW2_TEST === "1") {
  void import("./testing/test-api").then(({ installTestApi }) => {
    const install = (): void => {
      if (host === null) return
      installTestApi(host as never, {
        stop: () => {
          handle({ type: "stop" })
        },
        reset: (seed) => {
          newSession(seed)
        },
      })
    }
    afterNewSession = install
    install()
  })
}
