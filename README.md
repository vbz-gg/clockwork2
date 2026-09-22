# Clockwork 2

A game engine for browser games whose results someone else has to check.

The browser records what the player pressed. A server replays that recording and
computes the score itself. If the two disagree, the score is not real. That works
only if the game is a pure function of its seed, its configuration and its
inputs, on every JavaScript engine a player might be using, and most of this
project is the work of making that true and keeping it true.

```bash
bun install
bun run build
bun run demo          # play Snake, record it, replay it
```

## Live demo

<https://vbz-gg.github.io/clockwork2/> is the Snake demo, built from `main`.
Play a round, download the recording, then load it back: the page replays it and
puts the replay's state hash beside the one the run recorded.

## What it gives you

A fixed-step simulation loop. Your game advances one tick at a time and never
sees a time delta, so it cannot depend on the player's frame rate. The host
absorbs uneven frames by running more ticks, never bigger ones.

Deterministic maths. `Math.sin`, `Math.pow` and the rest are allowed to give
different answers in different engines, and they do: `Math.cos(0.1)` is
`0x3FEFD712F9A817C1` on JavaScriptCore and `0x3FEFD712F9A817C0` on V8. The
kernel ships `dmath` with the same function names, written from operations
ECMAScript specifies exactly.

Seeded randomness, in labelled sub-streams, with its state in the snapshot.

Recordings that replay. A recording is a seed, a configuration, the inputs
stamped with the tick they run on, a state hash every second, and an end tick.
Replaying it is the same loop reading inputs from a file instead of a keyboard.

A conformance suite. Twelve checks with stable error codes, run the same way
locally and by whatever platform accepts the game.

Renderers that cannot cheat. A presentation reads the view and writes nothing,
so it can use anything the simulation may not: `Math.random`, `performance.now`,
WebGL, audio.

## A game

Eight methods, no base class, no prescribed shape for your state:

```ts
interface GameModule<TView, TConfig> {
  readonly manifest: unknown

  init(seed: string, config: TConfig): void   // deterministic setup, no I/O
  tick(inputs: readonly InputEvent[]): void   // advance one tick; the only writer
  view(): TView                               // what the renderer reads
  snapshot(): Snapshot                        // plain data: hash, save, restore
  restore(snapshot: Snapshot): void           // restore then continue == continue
  score(): Counters                           // declared counters, integers
  isOver(): boolean                           // true once, never false again
  effects(): readonly Effect[]                // sound and camera cues, host drains
}
```

To start one:

```bash
bun run skill/platform-game/scripts/new.ts ./my-game
cd ./my-game && bun install
bun run validate      # the conformance suite; it passes before you change anything
bun run dev
```

The scaffold comes from `skill/platform-game/`, an Agent Skill that carries the
rules a game has to follow, a section per error code, and two starter templates.
Coding agents read it; so can you.

## One package, several entry points

`@clockwork2/engine` ships with **no runtime dependencies**. `pixi.js`, `three`
and `typescript` are optional peers, so a consumer who wants only the
simulation installs nothing else. Every entry point below is a separate
subpath with its own types, and the package is `"sideEffects": false`, so a
bundler keeps what you import and drops the rest.

| Import | What it is |
| --- | --- |
| `@clockwork2/engine` | The simulation kernel: loop, PRNG, timers, hashing, `dmath`, manifest, recording. |
| `@clockwork2/engine/validate` | The twelve conformance checks and their CLI. |
| `@clockwork2/engine/host` | The frame loop, input capture, audio, and the iframe and worker protocol. |
| `@clockwork2/engine/adapter-canvas2d` | Read-only presentation on a 2D canvas. |
| `@clockwork2/engine/adapter-three` | Read-only presentation on Three.js. |
| `@clockwork2/engine/adapter-pixi` | Read-only presentation on PIXI 8. |

## What is verified, and how

```bash
bun test              # unit tests, the demo's frozen recordings, and the skill
bun run test:coverage # the same tests, then the coverage floor
bun run test:engines  # the same vectors under every installed JS engine
bun run test:e2e      # Playwright: record, replay, frame rates, cross-runtime
bun run demo          # the Snake demo, with record and replay
```

CI runs four things that matter more than the rest.

The cross-engine sweep builds one probe bundle and runs those exact bytes under
Bun (JavaScriptCore), Node (V8), Chromium, Firefox (SpiderMonkey) and WebKit,
comparing 24 vector groups as hex bit patterns. 300,000 `dmath` evaluations and
100,000 PRNG draws produce identical digests on all five.

The frame-rate suite replays one input log at 240, 144, 60, 30, 20 and 5 Hz,
under a jitter pattern, and under CPU throttling, and asserts the checkpoint
hashes are identical, with a guard that the slow runs really did catch up rather
than quietly simulate less.

The cross-boundary test plays a session in a real browser with real key events,
writes the recording to disk, replays it under Bun and under Node, and compares
all three.

CI holds coverage over `packages/*/src` at 99% of lines. It is at 99.67%, and
the 18 uncovered lines are a load-time refusal only a big-endian build reaches,
a branch `String.prototype.split` cannot produce, and a guard for a runtime that
has frozen one of the globals the shims trap.

## Documentation

- [docs/engine.md](docs/engine.md) explains the engine from first principles:
  the loop, the contract, determinism, rendering, recordings, the manifest, and
  why each choice was made.
- [skill/platform-game/SKILL.md](skill/platform-game/SKILL.md) is the working
  guide for writing a game, with the rules and their checks.
- [failure-modes.md](skill/platform-game/references/failure-modes.md) has one
  section per error code.

## Licence

MIT. See [LICENSE](LICENSE). The engine's architecture comes from
[Clockwork](https://github.com/hiddentao/clockwork-engine), and the attributions
are in [NOTICE](NOTICE).
