# Clockwork 2

[![npm](https://img.shields.io/npm/v/@clockwork2/engine?label=npm&color=blue)](https://www.npmjs.com/package/@clockwork2/engine)
[![CI](https://github.com/vbz-gg/clockwork2/actions/workflows/ci.yml/badge.svg?branch=main)](https://github.com/vbz-gg/clockwork2/actions/workflows/ci.yml)
[![Engines](https://img.shields.io/badge/engines-V8%20%7C%20JavaScriptCore%20%7C%20SpiderMonkey-brightgreen)](#what-is-verified-and-how)
[![Runtime dependencies](https://img.shields.io/badge/runtime%20dependencies-0-brightgreen)](#one-package-several-entry-points)
[![Coverage floor](https://img.shields.io/badge/coverage%20floor-99%25%20of%20lines-brightgreen)](#what-is-verified-and-how)
[![License](https://img.shields.io/badge/license-MIT-blue)](./LICENSE)

**A game engine for browser games whose results someone else has to check.**

The browser records what the player pressed. A server replays that recording and
computes the score itself. If the two disagree, the score is not real. That works
only if the game is a pure function of its seed, its configuration and its
inputs, on every JavaScript engine a player might be using, and most of this
project is the work of making that true and keeping it true.

```bash
bun add @clockwork2/engine
```

## Live demo

<https://vbz-gg.github.io/clockwork2/> is the Snake demo, built from `main`.
Play a round, download the recording, then load it back: the page replays it and
puts the replay's state hash beside the one the run recorded.

To run it locally:

```bash
bun install
bun run build
bun run demo          # play Snake, record it, replay it
```

## What it gives you

The loop is fixed-step. Your game advances one tick at a time and never sees a
time delta, so it cannot depend on the player's frame rate. The host absorbs an
uneven frame by running more ticks, never a bigger one.

`dmath` replaces the parts of `Math` that engines are allowed to disagree about,
and do: `Math.cos(0.1)` is `0x3FEFD712F9A817C1` on JavaScriptCore and
`0x3FEFD712F9A817C0` on V8. Every `dmath` function is a transcription of the
fdlibm routine of the same name, built from operations ECMAScript specifies
exactly, so it returns the same bits on all three engines.

Randomness is seeded, drawn from labelled sub-streams, and carried in the
snapshot like any other state.

A recording is a seed, a configuration, the inputs stamped with the tick they run
on, a state hash every second, and an end tick. Replaying it is the same loop
reading inputs from a file instead of a keyboard.

The conformance suite is twelve checks with stable error codes, run the same way
on your machine and by whatever platform accepts the game.

A presentation reads the view and writes nothing, which is what lets it use
everything the simulation may not: `Math.random`, `performance.now`, WebGL,
audio.

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

`@clockwork2/engine` ships with no runtime dependencies. `pixi.js`, `three` and
`typescript` are optional peers, so a consumer who wants only the simulation
installs nothing else. Every entry point below is a separate subpath with its own
types, and the package is `"sideEffects": false`, so a bundler keeps what you
import and drops the rest.

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

Coverage over `packages/engine/src` is held at 99% of lines. It sits at 99.67%,
and the 18 uncovered lines are a load-time refusal only a big-endian build
reaches, a branch `String.prototype.split` cannot produce, and a guard for a
runtime that has frozen one of the globals the shims trap.

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
