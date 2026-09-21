/**
 * The demo's controls.
 *
 * The panel answers three questions, in this order: what is happening right
 * now, how is the game going, and did the replay reach the same state. The
 * last one is the point of the whole demo, so it is the only thing that ever
 * gets to be loud, and it appears only once there is a replay to judge.
 *
 * Two things the earlier panel did that this one does not. It reported
 * `Status` and `Mode` as separate rows, so "am I recording or watching a
 * replay" had to be assembled from two lines of small type; here one phase
 * names it. And it drew Pause beside Resume, of which exactly one was ever
 * enabled; here one button carries both.
 *
 * The panel owns which controls are live, derived from the state it is
 * handed. Nothing outside calls in to enable a button, so there is one place
 * where that decision is made rather than one per caller.
 */

export type UiAction =
  | { readonly type: "new-game"; readonly seed: string }
  | { readonly type: "stop" }
  | { readonly type: "replay" }
  | { readonly type: "toggle-pause" }
  | { readonly type: "speed"; readonly value: number }
  | { readonly type: "download" }
  | { readonly type: "load"; readonly text: string }

/** What the reader is looking at, as one word the panel can show. */
export type Phase =
  | "idle"
  | "recording"
  | "recording-paused"
  | "stopped"
  | "replaying"
  | "replay-paused"
  | "replayed"

export interface UiState {
  readonly phase: Phase
  readonly tick: number
  readonly apples: number
  readonly target: number
  /** The state hash of the session on screen. */
  readonly lastHash: string
  /** The hash the recording ended on, during a replay. Null otherwise. */
  readonly recordedHash: string | null
  /** What could be replayed or saved, once there is something. */
  readonly recording: {
    readonly ticks: number
    readonly inputs: number
  } | null
}

/**
 * One row per phase, read by one code path.
 *
 * `live` means the session can be paused or stopped, which is what decides
 * those two buttons; `paused` decides only which word the toggle shows.
 */
const PHASES: Record<
  Phase,
  {
    readonly label: string
    readonly dot: string
    readonly live: boolean
    readonly paused: boolean
  }
> = {
  idle: { label: "Ready", dot: "#8b90ab", live: false, paused: false },
  recording: { label: "Recording", dot: "#6ee7a8", live: true, paused: false },
  "recording-paused": {
    label: "Paused",
    dot: "#f0c674",
    live: true,
    paused: true,
  },
  stopped: { label: "Stopped", dot: "#8b90ab", live: false, paused: false },
  replaying: { label: "Replaying", dot: "#8f8ff5", live: true, paused: false },
  "replay-paused": {
    label: "Replay paused",
    dot: "#f0c674",
    live: true,
    paused: true,
  },
  replayed: {
    label: "Replay finished",
    dot: "#8f8ff5",
    live: false,
    paused: false,
  },
}

const STYLE = `
.cw2 { font: 14px/1.5 ui-sans-serif, system-ui, sans-serif; color: #cfd3e6; }
.cw2-mono { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; }
.cw2-wrap { display: flex; gap: 20px; align-items: flex-start; flex-wrap: wrap; }
.cw2-stage { background: #12121f; border-radius: 10px; overflow: hidden;
  width: min(600px, 92vw); aspect-ratio: 1; }
/* The presentation builds its canvas at a fixed 600 by 600, so on any screen
   narrower than that the element overflowed a stage that clips: a 390px phone
   saw the top-left 342px of the board, with the snake off the edge whenever it
   went right of column 14. The renderer writes that size onto the element as an
   inline style, which outranks a plain rule here, hence !important. It is a
   display scale only - the renderer still draws 600 by 600, so nothing about
   what is drawn or recorded changes. */
.cw2-stage canvas { display: block; width: 100% !important; height: 100% !important; }
.cw2-panel { min-width: 260px; max-width: 320px; flex: 1 1 260px;
  display: flex; flex-direction: column; gap: 16px; }
.cw2 h1 { font-size: 19px; font-weight: 600; line-height: 1.25; margin: 0 0 2px;
  color: #eef0f8; }
.cw2-sub { margin: 0; font-size: 13px; color: #8b90ab; }

.cw2-banner { display: flex; align-items: center; gap: 10px; background: #171728;
  border: 1px solid #2a2a44; border-radius: 8px; padding: 11px 13px; }
.cw2-dot { width: 9px; height: 9px; border-radius: 99px; flex-shrink: 0; }
.cw2-phase { flex-grow: 1; font-weight: 500; color: #eef0f8; }
.cw2-tick { font-size: 13px; color: #8b90ab; }

.cw2-line { display: flex; align-items: baseline; gap: 8px; margin-bottom: 6px; }
.cw2-line > :first-child { flex-grow: 1; font-size: 13px; color: #8b90ab; }
.cw2-line > :last-child { font-size: 13px; color: #eef0f8; }
.cw2-bar { height: 6px; border-radius: 99px; background: #23233c; overflow: hidden; }
.cw2-bar > div { height: 100%; border-radius: 99px; background: #00cc00;
  transition: width 120ms linear; }

.cw2-row { display: flex; gap: 8px; }
.cw2 button { font: inherit; background: #23233c; color: #dfe2f0;
  border: 1px solid #35355a; border-radius: 7px; padding: 9px 12px;
  min-height: 44px; cursor: pointer; }
.cw2 button:hover:not(:disabled) { background: #2d2d4d; }
.cw2 button:disabled { opacity: 0.4; cursor: default; }
.cw2 button.cw2-primary { background: #5b5bd6; border-color: #5b5bd6;
  color: #ffffff; font-weight: 500; flex-grow: 1; }
.cw2 button.cw2-primary:hover:not(:disabled) { background: #6a6ae0; }
.cw2 button.cw2-grow { flex-grow: 1; }

.cw2-seedrow { display: flex; align-items: center; gap: 10px; }
.cw2-seedrow label { font-size: 13px; color: #8b90ab; }
.cw2 input[type=text] { font: 13px/1.5 ui-monospace, SFMono-Regular, Menlo, monospace;
  background: #171728; color: #dfe2f0; border: 1px solid #35355a;
  border-radius: 7px; padding: 8px 10px; flex-grow: 1; min-width: 0; }
.cw2 input[type=range] { width: 100%; accent-color: #5b5bd6; }

.cw2-rule { height: 1px; background: #2a2a44; }
.cw2-rec { display: flex; flex-direction: column; gap: 10px; }
.cw2-legend { font-size: 11px; text-transform: uppercase; letter-spacing: 0.08em;
  color: #8b90ab; }
.cw2-quiet { margin-top: auto; font-size: 12px; color: #6b7090; }

.cw2-hash { background: rgba(110, 231, 168, 0.09);
  border: 1px solid rgba(110, 231, 168, 0.45); border-radius: 8px; padding: 14px; }
.cw2-hash.cw2-failed { background: rgba(255, 128, 128, 0.09);
  border-color: rgba(255, 128, 128, 0.45); }
.cw2-verdict { display: flex; align-items: center; gap: 9px; margin-bottom: 11px;
  font-size: 15px; font-weight: 600; }
.cw2-pairs { display: grid; grid-template-columns: auto 1fr; gap: 4px 10px;
  font-size: 12px; }
.cw2-pairs > span:nth-child(odd) { color: #8b90ab; }
.cw2-match { color: #6ee7a8; }
.cw2-differ { color: #ff8080; }

[hidden] { display: none !important; }
`

const TICK = `<svg width="18" height="18" viewBox="0 0 24 24" fill="none"
  stroke="currentColor" stroke-width="2.5" stroke-linecap="round"
  stroke-linejoin="round" aria-hidden="true"><path d="M20 6 9 17l-5-5"/></svg>`

const CROSS = `<svg width="18" height="18" viewBox="0 0 24 24" fill="none"
  stroke="currentColor" stroke-width="2.5" stroke-linecap="round"
  stroke-linejoin="round" aria-hidden="true"><path d="M18 6 6 18M6 6l12 12"/></svg>`

export class Ui {
  readonly root: HTMLElement
  readonly stage: HTMLElement
  private readonly seedInput: HTMLInputElement
  private readonly speedInput: HTMLInputElement
  private readonly speedValue: HTMLElement
  private readonly dot: HTMLElement
  private readonly phaseLabel: HTMLElement
  private readonly tickLabel: HTMLElement
  private readonly applesLabel: HTMLElement
  private readonly applesFill: HTMLElement
  private readonly recording: HTMLElement
  private readonly recordingCounts: HTMLElement
  private readonly speedRow: HTMLElement
  private readonly quiet: HTMLElement
  private readonly verdict: HTMLElement
  private readonly verdictLine: HTMLElement
  private readonly playedHash: HTMLElement
  private readonly replayHash: HTMLElement
  private readonly buttons: Record<string, HTMLButtonElement> = {}

  constructor(
    container: HTMLElement,
    private readonly onAction: (action: UiAction) => void,
  ) {
    const style = document.createElement("style")
    style.textContent = STYLE
    document.head.appendChild(style)

    this.root = document.createElement("div")
    this.root.className = "cw2"
    this.root.innerHTML = `
      <div class="cw2-wrap">
        <div class="cw2-stage" id="cw2-stage"></div>
        <div class="cw2-panel">
          <div>
            <h1>Clockwork 2 - Snake</h1>
            <p class="cw2-sub">Arrow keys or WASD</p>
          </div>

          <div class="cw2-banner">
            <span class="cw2-dot" id="cw2-dot"></span>
            <span class="cw2-phase" id="cw2-phase">Ready</span>
            <span class="cw2-tick cw2-mono" id="cw2-tick">tick 0</span>
          </div>

          <div>
            <div class="cw2-line">
              <span>Apples</span>
              <span class="cw2-mono" id="cw2-apples">0 / 50</span>
            </div>
            <div class="cw2-bar"><div id="cw2-apples-fill" style="width:0%"></div></div>
          </div>

          <div class="cw2-row">
            <button type="button" class="cw2-primary" data-action="new-game">New game</button>
            <button type="button" data-action="toggle-pause">Pause</button>
            <button type="button" data-action="stop">Stop</button>
          </div>

          <div class="cw2-seedrow">
            <label for="cw2-seed">Seed</label>
            <input type="text" id="cw2-seed" value="demo-1" spellcheck="false" />
          </div>

          <div class="cw2-rec" id="cw2-rec" hidden>
            <div class="cw2-rule"></div>
            <div class="cw2-line">
              <span class="cw2-legend">Recording</span>
              <span class="cw2-mono" id="cw2-counts"></span>
            </div>
            <div id="cw2-speed-row">
              <div class="cw2-line">
                <label for="cw2-speed">Replay speed</label>
                <span class="cw2-mono" id="cw2-speed-label">1.0x</span>
              </div>
              <input type="range" id="cw2-speed" min="0.1" max="10" step="0.1" value="1" />
            </div>
            <div class="cw2-row">
              <button type="button" class="cw2-grow" data-action="replay">Replay</button>
              <button type="button" class="cw2-grow" data-action="download">Save</button>
              <button type="button" class="cw2-grow" data-action="load">Open</button>
            </div>
          </div>

          <div class="cw2-hash" id="cw2-verdict" hidden>
            <div class="cw2-verdict" id="cw2-verdict-line"></div>
            <div class="cw2-pairs cw2-mono">
              <span>played</span><span id="cw2-played"></span>
              <span>replay</span><span id="cw2-replay"></span>
            </div>
          </div>

          <div class="cw2-quiet cw2-mono" id="cw2-quiet"></div>
        </div>
      </div>
    `
    container.appendChild(this.root)

    const find = <T extends HTMLElement>(id: string): T =>
      this.root.querySelector(`#${id}`) as T

    this.stage = find("cw2-stage")
    this.seedInput = find<HTMLInputElement>("cw2-seed")
    this.speedInput = find<HTMLInputElement>("cw2-speed")
    this.speedValue = find("cw2-speed-label")
    this.dot = find("cw2-dot")
    this.phaseLabel = find("cw2-phase")
    this.tickLabel = find("cw2-tick")
    this.applesLabel = find("cw2-apples")
    this.applesFill = find("cw2-apples-fill")
    this.recording = find("cw2-rec")
    this.recordingCounts = find("cw2-counts")
    this.speedRow = find("cw2-speed-row")
    this.quiet = find("cw2-quiet")
    this.verdict = find("cw2-verdict")
    this.verdictLine = find("cw2-verdict-line")
    this.playedHash = find("cw2-played")
    this.replayHash = find("cw2-replay")

    for (const node of this.root.querySelectorAll("button")) {
      const button = node as HTMLButtonElement
      const action = button.dataset.action as string
      this.buttons[action] = button
      button.addEventListener("click", () => {
        this.dispatch(action)
      })
    }

    this.speedInput.addEventListener("input", () => {
      const value = Number(this.speedInput.value)
      this.speedValue.textContent = `${value.toFixed(1)}x`
      this.onAction({ type: "speed", value })
    })
  }

  private dispatch(action: string): void {
    switch (action) {
      case "new-game":
        this.onAction({ type: "new-game", seed: this.seed })
        return
      case "load":
        this.pickFile()
        return
      case "stop":
      case "replay":
      case "toggle-pause":
      case "download":
        this.onAction({ type: action })
        return
      default:
        return
    }
  }

  private pickFile(): void {
    const input = document.createElement("input")
    input.type = "file"
    input.accept = "application/json,.json"
    input.addEventListener("change", () => {
      const file = input.files?.[0]
      if (file === undefined) return
      void file.text().then((text) => {
        this.onAction({ type: "load", text })
      })
    })
    input.click()
  }

  /**
   * The whole panel from one state.
   *
   * Text nodes and attributes are written in place rather than through
   * innerHTML, because this runs on every frame and rebuilding the markup
   * would take the seed box's focus and selection with it.
   */
  update(state: UiState): void {
    const phase = PHASES[state.phase]

    this.dot.style.background = phase.dot
    this.phaseLabel.textContent = phase.label
    this.tickLabel.textContent = `tick ${state.tick}`

    this.applesLabel.textContent = `${state.apples} / ${state.target}`
    const share = state.target === 0 ? 0 : (state.apples / state.target) * 100
    this.applesFill.style.width = `${Math.min(100, share).toFixed(1)}%`

    const toggle = this.buttons["toggle-pause"]
    if (toggle !== undefined)
      toggle.textContent = phase.paused ? "Resume" : "Pause"
    this.enable("toggle-pause", phase.live)
    this.enable("stop", phase.live)

    const recording = state.recording
    this.recording.hidden = recording === null
    if (recording !== null) {
      this.recordingCounts.textContent = `${recording.ticks} ticks, ${recording.inputs} inputs`
    }
    this.enable("replay", recording !== null)
    this.enable("download", recording !== null)
    // The slider only means something once a replay can be run, and a replay
    // needs a recording, so it travels with the block that offers one.
    this.speedRow.hidden = recording === null

    const recorded = state.recordedHash
    this.verdict.hidden = recorded === null
    this.quiet.hidden = recorded !== null
    if (recorded === null) {
      // A mismatch from an earlier replay leaves its colours behind on
      // elements that are only hidden, and `.cw2-differ` still being in the
      // document is exactly what the end-to-end spec reads as a failure.
      this.verdictLine.className = "cw2-verdict"
      this.replayHash.className = ""
      this.quiet.textContent = `state ${state.lastHash}`
      return
    }

    const matches = recorded === state.lastHash
    this.verdict.classList.toggle("cw2-failed", !matches)
    this.verdictLine.className = `cw2-verdict ${matches ? "cw2-match" : "cw2-differ"}`
    this.verdictLine.innerHTML = `${matches ? TICK : CROSS}<span>${
      matches ? "Same state" : "Different state"
    }</span>`
    this.playedHash.textContent = recorded
    this.playedHash.className = ""
    this.replayHash.textContent = state.lastHash
    this.replayHash.className = matches ? "cw2-match" : "cw2-differ"
  }

  private enable(action: string, enabled: boolean): void {
    const button = this.buttons[action]
    if (button !== undefined) button.disabled = !enabled
  }

  get seed(): string {
    return this.seedInput.value.trim() || "demo-1"
  }
}
