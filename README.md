# Clockwork 2

A deterministic, fixed-step game kernel for browser games whose results have to
be verified rather than trusted.

The browser records what the player pressed. The server replays that input log
and recomputes the result. If the two disagree, the score is not real. That only
works if the simulation is a pure function of its seed, its config and its
inputs, on every JavaScript engine a player might be using. Clockwork 2 exists
to make that property hold and to make it testable.

Clockwork 2 is a clean-room successor to
[Clockwork 1](https://github.com/hiddentao/clockwork-engine). It keeps that
project's architecture and changes the timing model. See
[docs/differences.md](docs/differences.md).

## How it works

The host owns the clock. `requestAnimationFrame` is the pump, not the timebase:

```js
const STEP_MS = 1000 / tickHz
let accumulator = 0, last = performance.now(), tick = 0

function frame(now) {
  accumulator += Math.min(now - last, MAX_FRAME_MS)
  last = now

  let steps = 0
  while (accumulator >= STEP_MS && steps < MAX_CATCHUP) {
    game.tick(inputsAt(tick)); tick++; accumulator -= STEP_MS; steps++
  }
  if (steps === MAX_CATCHUP) accumulator = 0

  presentation.render(game.view(), prevView, accumulator / STEP_MS, elapsed)
  requestAnimationFrame(frame)
}
```

Frame jitter changes how **many** ticks run in a frame. It never changes how
**big** a tick is. `tick()` takes no delta at all, so there is nothing for the
frame rate to get into. The leftover fraction becomes the renderer's
interpolation factor, and the renderer only reads, so it cannot reach the
result. The server has no animation frames and no renderer: it runs
`for (let t = 0; t < endTick; t++) game.tick(inputsAt(t))`.

## The contract

```ts
GameModule                      // default export
  manifest                      // JSON the platform validates without running the game
  init(seed, config)            // deterministic setup, no I/O
  tick(inputs)                  // advance exactly one tick; the only writer of state
  view()                        // what the renderer reads
  snapshot()                    // plain data, for hashing, restore and submission
  restore(snapshot)             // restore-then-continue must equal continue
  score()                       // declared counters, integers
  isOver()                      // true once, never flips back
  effects()                     // sound and camera cues, drained by the host

Presentation                    // browser only
  mount(container, context)
  render(view, previousView, alpha, dtMs)   // reads; never writes
  unmount()
```

A recording is the seed, the config, the inputs stamped with the tick they run
on, a state hash every second, and the end tick. There is no delta array. The
checkpoints are not needed to replay; they exist so a divergence can be traced
to the second it happened.

## Packages

| Package | What it is |
| --- | --- |
| `@clockwork2/kernel` | The simulation kernel. Zero runtime dependencies. |
| `@clockwork2/validate` | The conformance suite and its CLI. |
| `@clockwork2/host-bridge` | Host loop, input capture, iframe and worker protocol. |
| `@clockwork2/adapter-canvas2d` | Read-only presentation on a 2D canvas. |
| `@clockwork2/adapter-three` | Read-only presentation on Three.js. |
| `@clockwork2/adapter-pixi` | Read-only presentation on PIXI 8. |
| `@clockwork2/compat-clockwork1` | `GameObject`, `Vector2D`, `CollisionGrid` for ported games. |

Beside them, `skill/platform-game/` is the agent skill: the rules an agent
writing a game has to follow, each naming the check that enforces it, a section
per error code, and two starter templates that pass the conformance suite
before a line of them is changed. Its API reference is generated from the type
declarations and `bun test skill` fails when the two disagree.

## Getting started

```bash
bun install
bun run build
bun test              # unit tests, the demo's frozen recordings, and the skill
bun run test:engines  # the same vectors under every installed JS engine
bun run demo          # the Snake demo, with record and replay
bun run test:e2e      # Playwright: record, replay, frame rates, cross-runtime
```

To start a game:

```bash
bun run skill/platform-game/scripts/new.ts ./my-game
cd ./my-game && bun install && bun run validate
```

## Determinism rules

A simulation may use `+ - * / %`, comparisons, `Math.sqrt`,
`Math.floor/ceil/round/trunc/abs/min/max/sign`, `Math.fround`, `Math.imul`,
`Math.clz32`, and typed-array bit manipulation. All of those are exactly
specified by ECMAScript, so they give the same bits everywhere.

`Math.sin`, `Math.cos`, `Math.pow` and the rest of the transcendental functions
are not specified, and they really do differ. Measured on 20,000 seeded inputs
per function between JavaScriptCore and V8: `Math.hypot` disagreed on 32.6% of
them, `Math.exp` on 10.3%, `Math.pow` on 9.0%, `Math.cos` on 3.2%. `Math.cos(0.1)`
is `0x3FEFD712F9A817C1` on one and `0x3FEFD712F9A817C0` on the other.
`Math.sqrt` disagreed on none, which is what "exactly specified" buys.

So the kernel ships `dmath`, with the same function names, implemented from
exactly specified operations only. `Math.pow` and the `**` operator are banned
outright. `@clockwork2/validate` scans for violations and the kernel installs
runtime traps during `init` and `tick`, because a scan misses aliased globals
and a trap misses a path that never runs.

## Licence

MIT. See [LICENSE](LICENSE) and [NOTICE](NOTICE).
