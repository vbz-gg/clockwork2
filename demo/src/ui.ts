/**
 * The demo's controls.
 *
 * Hand-rolled DOM, like Clockwork 1's, with what makes replay demonstrable
 * added: an explicit record and stop, a seed box, download and load, and a
 * live checkpoint hash. The hash is the point of the whole panel - it is what
 * lets someone watch a replay and see, rather than be told, that it reached
 * the same state.
 */

export type UiAction =
  | { readonly type: "new-game"; readonly seed: string }
  | { readonly type: "stop" }
  | { readonly type: "replay" }
  | { readonly type: "pause" }
  | { readonly type: "resume" }
  | { readonly type: "speed"; readonly value: number }
  | { readonly type: "download" }
  | { readonly type: "load"; readonly text: string }

export interface UiState {
  readonly status: string
  readonly tick: number
  readonly apples: number
  readonly target: number
  readonly length: number
  readonly fps: number
  readonly mode: "playing" | "replaying" | "idle"
  readonly lastHash: string
  readonly recordedHash: string | null
  readonly seed: string
}

const STYLE = `
.cw2 { font: 13px/1.5 ui-monospace, SFMono-Regular, Menlo, monospace; color: #cfd3e6; }
.cw2-wrap { display: flex; gap: 20px; align-items: flex-start; flex-wrap: wrap; }
.cw2-stage { background: #12121f; border-radius: 10px; overflow: hidden;
  width: min(600px, 92vw); aspect-ratio: 1; }
.cw2-panel { min-width: 260px; max-width: 340px; display: grid; gap: 14px; }
.cw2 h1 { font: 600 17px/1.3 ui-sans-serif, system-ui, sans-serif; margin: 0 0 4px;
  color: #eef0f8; }
.cw2 p.cw2-sub { margin: 0 0 8px; color: #8b90ab; font-size: 12px; }
.cw2 fieldset { border: 1px solid #2a2a44; border-radius: 8px; padding: 10px 12px; margin: 0; }
.cw2 legend { padding: 0 6px; color: #8b90ab; font-size: 11px; text-transform: uppercase;
  letter-spacing: 0.08em; }
.cw2 button { font: inherit; background: #23233c; color: #dfe2f0; border: 1px solid #35355a;
  border-radius: 6px; padding: 6px 10px; cursor: pointer; }
.cw2 button:hover:not(:disabled) { background: #2d2d4d; }
.cw2 button:disabled { opacity: 0.45; cursor: default; }
.cw2 input[type=text] { font: inherit; background: #171728; color: #dfe2f0;
  border: 1px solid #35355a; border-radius: 6px; padding: 5px 8px; width: 100%; }
.cw2 input[type=range] { width: 100%; }
.cw2-row { display: flex; gap: 6px; flex-wrap: wrap; }
.cw2-stats { display: grid; grid-template-columns: auto 1fr; gap: 2px 12px; }
.cw2-stats dt { color: #8b90ab; }
.cw2-stats dd { margin: 0; color: #eef0f8; }
.cw2-hash { font-size: 11px; word-break: break-all; }
.cw2-match { color: #6ee7a8; }
.cw2-differ { color: #ff8080; }
`

export class Ui {
  readonly root: HTMLElement
  readonly stage: HTMLElement
  private readonly seedInput: HTMLInputElement
  private readonly speedInput: HTMLInputElement
  private readonly stats: HTMLElement
  private readonly hashLine: HTMLElement
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
            <p class="cw2-sub">Arrow keys or WASD. The browser records what you
            press; the same log replays to the same state anywhere.</p>
          </div>
          <fieldset>
            <legend>Session</legend>
            <label for="cw2-seed" style="display:block;color:#8b90ab;font-size:11px">Seed</label>
            <input type="text" id="cw2-seed" value="demo-1" />
            <div class="cw2-row" style="margin-top:8px">
              <button data-action="new-game">New game</button>
              <button data-action="stop">Stop</button>
            </div>
          </fieldset>
          <fieldset>
            <legend>Replay</legend>
            <div class="cw2-row">
              <button data-action="replay">Replay</button>
              <button data-action="pause">Pause</button>
              <button data-action="resume">Resume</button>
            </div>
            <label for="cw2-speed" style="display:block;margin-top:8px;color:#8b90ab;font-size:11px">
              Speed <span id="cw2-speed-label">1.0x</span>
            </label>
            <input type="range" id="cw2-speed" min="0.1" max="10" step="0.1" value="1" />
            <div class="cw2-row" style="margin-top:8px">
              <button data-action="download">Download</button>
              <button data-action="load">Load</button>
            </div>
          </fieldset>
          <fieldset>
            <legend>State</legend>
            <dl class="cw2-stats" id="cw2-stats"></dl>
            <div class="cw2-hash" id="cw2-hash" style="margin-top:8px"></div>
          </fieldset>
        </div>
      </div>
    `
    container.appendChild(this.root)

    this.stage = this.root.querySelector("#cw2-stage") as HTMLElement
    this.seedInput = this.root.querySelector("#cw2-seed") as HTMLInputElement
    this.speedInput = this.root.querySelector("#cw2-speed") as HTMLInputElement
    this.stats = this.root.querySelector("#cw2-stats") as HTMLElement
    this.hashLine = this.root.querySelector("#cw2-hash") as HTMLElement

    for (const button of this.root.querySelectorAll("button")) {
      const element = button as HTMLButtonElement
      const action = element.dataset.action as string
      this.buttons[action] = element
      element.addEventListener("click", () => {
        this.dispatch(action)
      })
    }

    const speedLabel = this.root.querySelector(
      "#cw2-speed-label",
    ) as HTMLElement
    this.speedInput.addEventListener("input", () => {
      const value = Number(this.speedInput.value)
      speedLabel.textContent = `${value.toFixed(1)}x`
      this.onAction({ type: "speed", value })
    })
  }

  private dispatch(action: string): void {
    switch (action) {
      case "new-game":
        this.onAction({
          type: "new-game",
          seed: this.seedInput.value.trim() || "demo-1",
        })
        return
      case "load":
        this.pickFile()
        return
      case "stop":
      case "replay":
      case "pause":
      case "resume":
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

  update(state: UiState): void {
    this.stats.innerHTML = [
      ["Status", state.status],
      ["Mode", state.mode],
      ["Tick", String(state.tick)],
      ["Apples", `${state.apples} / ${state.target}`],
      ["Length", String(state.length)],
      ["Frames", `${state.fps.toFixed(0)}/s`],
    ]
      .map(([term, value]) => `<dt>${term}</dt><dd>${value}</dd>`)
      .join("")

    if (state.recordedHash === null) {
      this.hashLine.innerHTML = `<span style="color:#8b90ab">state hash</span><br>${state.lastHash}`
      return
    }
    const matches = state.recordedHash === state.lastHash
    this.hashLine.innerHTML = `
      <span style="color:#8b90ab">recorded</span><br>${state.recordedHash}<br>
      <span style="color:#8b90ab">replay&nbsp;&nbsp;</span><br>
      <span class="${matches ? "cw2-match" : "cw2-differ"}">${state.lastHash}</span>
      <br><span class="${matches ? "cw2-match" : "cw2-differ"}">${
        matches ? "identical" : "DIFFERENT"
      }</span>`
  }

  setEnabled(action: string, enabled: boolean): void {
    const button = this.buttons[action]
    if (button !== undefined) button.disabled = !enabled
  }

  get seed(): string {
    return this.seedInput.value.trim() || "demo-1"
  }
}
