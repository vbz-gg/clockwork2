# Differences from Clockwork 1

Clockwork 2 keeps Clockwork 1's architecture and changes its layering. This page
says what moved and why, so that someone who knows Clockwork 1 can read the new
code without guessing.

Clockwork 1 is `hiddentao/clockwork-engine` at version 2.9.0: 4,958 lines of
core TypeScript, 27,688 lines of tests, three packages and a PIXI Snake demo.

## 1. The timing model

This is the whole reason the project exists.

Clockwork 1 is variable-step. `PixiRenderingLayer.onTick` computes
`deltaTicks = ~~(ticker.deltaTime * 1000)` and passes it to `engine.update()`.
PIXI's `deltaTime` is real elapsed time expressed in units of one 60 Hz frame
(`deltaTime = deltaMS * 0.06`), so it sits near 1.0 on a healthy display but is
never fixed: a 16.4 ms frame gives 0.984 and a 17.1 ms frame gives 1.026, which
become 984 and 1026 ticks. PIXI's only timing controls are a clamp (`minFPS`,
capping a frame at 100 ms) and a frame-skip throttle (`maxFPS`). Neither
quantises.

Clockwork 1 gets determinism back by **recording the deltas and replaying
them**. That works, and it has four consequences that a platform paying on
results cannot accept:

1. The simulation depends on the player's frame rate, so two players on the same
   seed do not play the same game.
2. The delta array comes from the client, so the client decides how much
   simulation runs.
3. `validateRecording` checks shape and `delta > 0`. `NaN` and `Infinity` pass
   and then stall the replay, so every consumer needs a timeout.
4. Replaying with one `update(totalTicks)` call is not the computation that
   produced the recording. A skipped interval timer fires repeatedly inside that
   one update, bounded by `TIMER_CONSTANTS.MAX_ITERATIONS = 1000`.

Clockwork 2 is fixed-step. `tick()` takes no argument beyond its inputs. The
host accumulates real elapsed time and runs zero or more whole ticks per frame,
with a cap on catch-up. The recording has no delta array.

A Clockwork 1 tick is 1/60,000 of a second. A Clockwork 2 tick is one simulation
step at the rate the manifest declares, normally 60 per second. Porting a game
means dividing its tick constants by 1,000.

## 2. What the kernel keeps

| Clockwork 1 | Clockwork 2 |
| --- | --- |
| `PRNG` over `alea` | `Prng` over the same vendored alea, with a mandatory seed, labelled sub-streams, and `exportState`/`importState` exposed |
| `Timer` | `Timer`, simplified: a step is always one tick, so the catch-up loop and its 1,000-iteration guard are gone |
| `Serializer` | The canonical encoder. The module-level singleton becomes a per-session registry |
| `EventEmitter` | Carried across as is |
| Input stamping at drain time | Kept, but the host stamps an input with the tick the simulation is **about to** run, not the tick of whichever update drained the queue |
| The headless memory platform | The default. The kernel needs no platform at all |

`PRNG` in Clockwork 1 calls `alea()` with no argument in its constructor, which
seeds from `+new Date`, and relies on a later `reset(seed)`. A config with no
`prngSeed` reseeds with `alea("")`. In Clockwork 2 the seed is required and
there is no unseeded path.

## 3. What the kernel drops

`GameCanvas`, `AbstractRenderer`, `DisplayNode`, the whole `platform/` layer,
`AssetLoader`, `Spritesheet`, `CollisionGrid`, `Vector2D` and PIXI leave the
kernel. None of them is needed to compute a score from a seed and an input log.

The geometry and game-object helpers come back as `@clockwork2/compat-clockwork1`
for ported games. The renderers come back as adapters.

Three structural knots are cut rather than moved:

- **The clock lived in the renderer.** `RenderingLayer` owns `onTick`,
  `setTickerSpeed` and `getFPS`, and `GameCanvas.update()` calls
  `gameEngine.update(deltaTicks)` and then `this.render(deltaTicks)`. The
  renderer drove the simulation. In Clockwork 2 the host drives both and the
  renderer is handed a frame to draw.
- **The renderer wrote to simulation state.** `AbstractRenderer.updateNode()`
  reads `item.needsRepaint` and then sets it to `false`. With more than one sim
  step per frame, or more than one view of one world, that is wrong. Clockwork 2
  decides repainting from `view` against `previousView`.
- **The engine required a platform.** `GameEngine`'s constructor builds an
  `AssetLoader` from `platform.rendering` and `platform.audio`, and `reset()`
  awaits `assetLoader.preloadAssets()`. So an engine could not exist without a
  renderer, and resetting one was asynchronous and did I/O. The Clockwork 2
  kernel imports nothing and `init` is synchronous.

`BaseRenderer` is documented in Clockwork 1's `CLAUDE.md` and does not exist in
its code. It is not ported.

## 4. Recording and replay

Clockwork 1's recording is `{ gameConfig, events, deltaTicks, totalTicks,
metadata }`. Replay is a `Proxy` around the engine that intercepts `update` and
feeds back the recorded deltas.

Clockwork 2's recording is:

```
{ format, version, kernelVersion, gameId, gameVersion, manifestHash, tickHz,
  seed, config, inputs: [{ tick, device, code, value }], checkpoints:
  [{ tick, hash }], endTick, terminal, counters }
```

The `Proxy` is gone. Replay is the ordinary loop reading from a recorded input
source instead of a live one, which is the same computation the recording came
from. Checkpoints are a state hash every second; they are not needed to replay
and exist to locate a divergence.

`metadata.version` in Clockwork 1 is the hardcoded string `"1.0.0"`, not the
package version. The compressed envelope in `@tribally.games/game-base` writes a
`version` field that nothing ever reads, and that codebase has already changed
codec twice underneath it. Clockwork 2 checks `format` and `version` on decode
and throws `E_RECORDING_VERSION`.

Old recordings do not replay on this kernel and there is no legacy reader.

## 5. New in Clockwork 2

- **`dmath`**, deterministic transcendental math, because ECMAScript leaves
  `sin`, `cos`, `tan`, `asin`, `acos`, `atan`, `atan2`, `exp`, `log`, `pow` and
  the rest implementation-defined. Clockwork 1 has no equivalent and its games
  call `Math.cos` and `Math.sin` directly.
- **A canonical state hash** every second. Clockwork 1 has no checksum in
  shipped code; its test helpers have one.
- **Runtime shims** that trap banned globals during `init` and `tick`.
- **A manifest** the platform validates without running the game.
- **`restore()`**, so a snapshot can be proved complete.
- **`effects()`**, so audio leaves the simulation. Clockwork 1's demo calls
  `playSound()` from inside collision handling, which fires again on replay.
- **A conformance suite** with stable error codes.
- **Fixed-step by construction**, which is what all of the above is for.

## 6. Tooling

| Clockwork 1 | Clockwork 2 |
| --- | --- |
| Three `scripts/build.ts` files differing only in a banner string | `tsc -b` over project references |
| No `exports` map in any package | An `exports` map with subpaths, plus a `development` condition |
| Two `.versionrc.json` files; the one with the `prerelease` gate is never read | One, and the gate runs |
| `moduleResolution: "node"`, DOM types in the base tsconfig | `bundler`, and no DOM in the base |
| `biome.json` declares schema 2.1.3 against an installed 1.9.2 | Schema matches the pinned version |
| CI on every push, no PR trigger, no concurrency group, no caching, browser tests before lint | Push and pull request, concurrency group, cached, cheapest job first |
| Release publishes behind an interactive OTP prompt | Token-based |
