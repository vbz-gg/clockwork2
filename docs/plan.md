# Clockwork 2 - implementation plan

The handoff document this repository was built from. Kept here so the
specification travels with the code.

---

## 1. Context

Phase 0 of the vbz arcade needs an engine before anything else. The arcade pays
and ranks on results, so a score must be something the platform can verify
rather than trust: the browser records inputs, the server replays them, and
both sides must reach the same state.

Clockwork 1 (`hiddentao/clockwork-engine`) proved input-log replay works, but
cannot be patched into this role. Clockwork 2 keeps its architecture and
changes the layering.

### The determinism problem being fixed

Clockwork 1 is variable-step: `PixiRenderingLayer.ts:855` computes
`deltaTicks = ~~(ticker.deltaTime * 1000)` and hands it to `engine.update()`.

PIXI does not supply a fixed delta. From `pixi.js@8.13.2`,
`lib/ticker/Ticker.mjs`, `update()`:

```js
elapsedMS = this.elapsedMS = currentTime - this.lastTime;   // real, variable
if (elapsedMS > this._maxElapsedMS) elapsedMS = this._maxElapsedMS;  // clamp at 100ms
if (this._minElapsedMS) { ... if (delta < this._minElapsedMS) return; }  // skip frame
this.deltaMS = elapsedMS;
this.deltaTime = this.deltaMS * _Ticker.targetFPMS;         // targetFPMS = 0.06
```

`targetFPMS = 0.06` is `60/1000`, so `deltaTime` is real elapsed time expressed
in units of one 60 Hz frame. It sits near 1.0 on a healthy display, which is
why it reads as fixed, but a 16.4 ms frame gives 0.984 and a 17.1 ms frame
gives 1.026 - which Clockwork 1 turns into 984 and 1026 ticks. PIXI's only two
timing knobs are a clamp (`minFPS`, default 10, capping a frame at 100 ms) and
a frame-skip throttle (`maxFPS`, default off). Neither quantises.

Four consequences, all fatal to a platform that pays on results:

1. The simulation depends on the player's frame rate. Identical inputs on
   60 Hz and 144 Hz hardware produce different games, so standings on a shared
   daily seed are not comparable.
2. The delta array comes from the browser, so the client decides how much
   simulation runs. Tribally never compared the claimed score against the
   replayed one, which is how a divergent Snakes run got paid and ranked.
3. `validateRecording` checks only shape and `delta > 0`. `NaN` and `Infinity`
   pass and then stall the replay forever, so every consumer needs a timeout.
   The arcade's is 10 s of worker CPU per hostile recording.
4. Replaying a session with one `update(totalTicks)` call is not the same
   computation as the many small updates that produced it: a skipped interval
   timer fires repeatedly inside one update, capped at 1,000 iterations.

### The fix

`requestAnimationFrame` stays variable. It becomes the pump, not the clock.
PIXI is initialised `autoStart: false` and the host calls `app.render()`:

```js
const STEP_MS = 1000 / tickHz
let accumulator = 0, last = performance.now(), tick = 0

function frame(now) {
  const elapsed = Math.min(now - last, MAX_FRAME_MS)   // clamp a stalled tab
  last = now
  accumulator += elapsed

  let steps = 0
  while (accumulator >= STEP_MS && steps < MAX_CATCHUP) {
    game.tick(inputsAt(tick)); tick++; accumulator -= STEP_MS; steps++
  }
  if (steps === MAX_CATCHUP) accumulator = 0    // drop the debt, never burst

  presentation.render(game.view(), prevView, accumulator / STEP_MS, elapsed)
  app.render()                                  // PIXI is now a draw call
  requestAnimationFrame(frame)
}
```

Jitter is absorbed into how **many** ticks run per frame (0, 1, 2...), never
into how **big** a tick is. `tick()` takes no delta. The leftover fraction
becomes the renderer's interpolation factor, and the renderer is read-only, so
it cannot reach the result. The server has no rAF and no PIXI: it runs
`for (let t = 0; t < endTick; t++) game.tick(inputsAt(t))`.

Worked example, real rAF timings on a 60 Hz display at a 16.667 ms step:

| frame | elapsed | accumulator before | ticks run | after |
|---|---|---|---|---|
| 1 | 16.4 | 16.40 | 0 | 16.40 |
| 2 | 17.1 | 33.50 | 2 | 0.17 |
| 3 | 16.9 | 17.07 | 1 | 0.40 |
| 4 | 33.2 (dropped) | 33.60 | 2 | 0.27 |

### The recording, after the change

```
{ seed, config, manifestHash, kernelVersion, tickHz,
  inputs:      [{ tick, device, code, value }, ...],   // sorted by tick
  checkpoints: [{ tick, hash }, ...],                  // one per second
  endTick }
```

No delta array. Inputs still carry a tick index - that is now the only timing
data, and it is what makes replay exact. In Clockwork 1 an input's tick is the
tick of whichever update drained the queue, so it shifts with frame rate; here
the host stamps the input with the tick the simulation is about to run.

Checkpoints are **not** needed to replay. Replay is fully determined by seed,
config, inputs and `endTick`. Checkpoints exist to localise a divergence to the
second it happened.

---

## 2. Decisions taken (do not re-litigate)

| Decision | Choice |
|---|---|
| Name | Clockwork 2, based on the architecture of Clockwork 1, stated as such |
| Repo | `github.com/vbz-gg/clockwork2`, public, open source |
| Relationship | Clean-room successor. Fresh git history, not a GitHub fork |
| Licence | MIT, copyright Ramesh Nair, plus a NOTICE naming Clockwork 1 as origin |
| npm scope | `@clockwork2/*` (verified free on npm, as is the bare name `clockwork2`) |
| Scope of this work | The section 6.11 first release: kernel, validate, host-bridge, adapter-canvas2d, adapter-three, skill |
| Timing | Fixed-step integer ticks, rate declared per game (30/60/120 Hz), no delta array, no legacy reader |
| Old recordings | Not replayable. Anything needing a historical Tribally session keeps the old validator, outside this repo |
| Toolchain | Bun + TypeScript + Biome |

---

## 3. Facts verified by direct check

Each one changes the design; none is assumed.

- **`alea` is safe.** Core step is
  `t = 2091639*s0 + c*2.3283064365386963e-10; c = t|0; s2 = t - c`, and `Mash`
  uses only `charCodeAt`, `+`, `-`, `*`, `>>>`. All IEEE 754 exactly specified,
  no transcendentals, so the stream is bit-identical across V8, JavaScriptCore
  and SpiderMonkey.
- **`alea` exposes `exportState`/`importState`** returning `[s0, s1, s2, c]`.
  Clockwork 1's `PRNG` wrapper hides both. Clockwork 2 must expose them:
  `restore()` and conformance check 6 are meaningless unless generator state is
  part of the snapshot, since restoring game state alone diverges on the next
  draw.
- **`alea()` with no argument seeds from `+new Date`**, and Clockwork 1's
  `PRNG.ts:9` does exactly that when given no seed. In Clockwork 2 the seed is
  a required argument with no unseeded path.
- **PIXI's `deltaTime` is normalised, not fixed** - see section 1.
- **Runtimes.** Bun 1.3.11 (JavaScriptCore) and Node 22 (V8) are available in
  the session. SpiderMonkey is not installed and has no distro binary, so the
  third engine comes from Playwright's Firefox (already needed for the render
  smoke check), with a `jsvu` shell as fallback if driving a browser is too
  slow for the determinism sweep.
- **npm**: `@clockwork2/kernel`, `@clockwork2/core` and `clockwork2` all return
  404, and a scope search returns zero packages. The scope is free.

---

## 4. Repository layout

Bun workspace, one version across packages.

```
clockwork2/
  packages/
    kernel/              @clockwork2/kernel             the simulation kernel
    validate/            @clockwork2/validate           conformance suite + CLI
    host-bridge/         @clockwork2/host-bridge        host loop, input capture, iframe/worker protocol
    adapter-canvas2d/    @clockwork2/adapter-canvas2d
    adapter-three/       @clockwork2/adapter-three
  skill/platform-game/   the agent skill, versioned with the kernel major
  scripts/               one shared build script, release, version sync
  docs/differences.md
```

Every package gets an `exports` map with subpaths. Clockwork 1 has none, only
`main`/`types`. `@clockwork2/host-bridge` needs it most: `./parent` and
`./frame` are different environments and must not pull each other in.

**Dependency rule.** `@clockwork2/kernel` has **zero** runtime dependencies -
`alea` is vendored. Everything tooling-only is a devDependency of the package
that needs it. This is the direct lesson from game-base shipping React,
react-dom, react-toastify, Vite and `@vitejs/plugin-react` as runtime
`dependencies`, so importing one 25-line objectives helper installed the whole
React toolchain.

---

## 5. `@clockwork2/kernel`

```
src/
  contract.ts        GameModule and Presentation interfaces, InputEvent, Snapshot
  loop.ts            runSession() - the fixed-step driver shared by host and validator
  prng/alea.ts       vendored alea
  prng/index.ts      Prng: labelled sub-streams, mandatory seed, export/importState
  timer.ts           tick timers
  inputs.ts          input log, device vocabulary, analog quantisation, deadzones
  counters.ts        declared counters and threshold comparison
  fixed.ts           fixed-point helpers
  shims.ts           install/uninstall traps for banned globals
  errors.ts          the error-code table the skill is keyed on
  hash/canonical.ts  canonical encoding of a snapshot
  hash/hash64.ts     64-bit hash in two 32-bit lanes
  dmath/             deterministic sin, cos, tan, atan2, asin, acos, exp, log, pow, ipow
  manifest/{types.ts,schema.json,validate.ts}
  recording/{types.ts,codec.ts}
  testing/           fixtures: idle, chaos and generic-bot input logs
```

Four parts carry the real risk and are specified rather than left open.

### The loop

`runSession()` is one function used by both sides. The browser host drives it
from the accumulator above; the validator drives it from a `for` loop. `tick()`
takes no delta. The host clamps a single frame's elapsed time so a backgrounded
tab cannot produce a burst, and caps catch-up steps per frame, dropping the
remaining debt rather than spiralling.

The kernel throws if `tick()` returns a thenable.

### The state hash

Canonical encoding first: keys sorted; integers as 64-bit; floats by IEEE bit
pattern **without** normalising negative zero; `NaN`, `Infinity`, `undefined`,
functions and class instances rejected rather than coerced.

The hash is 64-bit computed in two 32-bit lanes using `Math.imul` and `>>>`,
both exactly specified, so it is identical in every engine and cheap enough to
run synchronously inside `tick` once a second.

### `dmath`

This decides whether cross-engine determinism works at all. ECMAScript leaves
`acos, acosh, asin, asinh, atan, atanh, atan2, cbrt, cos, cosh, exp, expm1,
hypot, log, log1p, log2, log10, pow, random, sin, sinh, tan, tanh`
implementation-defined, so a simulation cannot call them.

The kernel ships fdlibm-style polynomial cores written using only
exactly-specified operations: `+ - * / %`, comparisons, `Math.sqrt` (exactly
specified since August 2024), `Math.floor/ceil/round/trunc/abs/min/max/sign`,
`Math.fround`, `Math.imul`, `Math.clz32`, and typed-array bit manipulation.
They take the same names as `Math` so an agent reaches for them reflexively.
`**` and `Math.pow` are banned outright.

Correctness is pinned by golden vectors compared across all three engines in
CI, not by spot checks. JavaScript never fuses multiply-add, so JS arithmetic
is safe; WebAssembly is safe only without relaxed SIMD.

### The shims

Installed around `init` and `tick` and torn down after, so a violation throws
at the point of use with a code the skill's failure-modes reference explains.
Banned: `Math.random`, `Date`, `performance.now`, timers,
`requestAnimationFrame`, `crypto`, `Intl`, `toLocaleString`, `localeCompare`,
`WeakRef`, `FinalizationRegistry`, `structuredClone`, `queueMicrotask`,
`Atomics`, and `WebAssembly` outside an allow-list.

Shims are belt-and-braces alongside the static import-graph scan: a scan misses
aliased globals, `sendBeacon`, `new Image().src` and dynamic import; a shim
misses a path never executed. Both are needed.

---

## 6. The contract

```ts
GameModule (default export)
  manifest
  init(seed, config)        // deterministic setup, no I/O
  tick(inputs)              // advance exactly one tick; only writer of state; NO delta
  view()                    // live read-only reference for the renderer
  snapshot()                // canonical plain-data copy for hashing/restore/submission
  restore(snapshot)         // restore-then-continue must equal continue
  score()                   // declared counters, integers
  isOver()                  // true once, never flips back
  effects()                 // sound/haptic/camera cues from last tick; drained by host

Presentation (browser only)
  mount(container, context)                 // context carries renderer-side random + assets
  render(view, previousView, alpha, dtMs)   // reads only, never writes
  unmount()
```

Input events are constructed **only** by the host from device events (key,
pointer, touch, gamepad) in simulation units. The game bundle cannot make one.
This closes the failure the conformance suite cannot otherwise see: hit-testing
done in the renderer and fed to the simulation as a virtual input, which
replays perfectly with the score decided on the client.

Analog inputs (sticks, mouse deltas, touch) are quantised by the host to
integers with kernel-defined deadzones before the simulation sees them.

Audio and effects come out of `effects()`, never from inside `tick`, so a
headless run has nothing to stub.

`view()` and `restore()` exist for concrete reasons: a per-tick plain-data copy
for the renderer is the whole frame budget in a 3D game, and without `restore`
there is no save, no resume, no partial replay and no way to test that a
snapshot is complete.

---

## 7. The manifest

A JSON document the platform validates **without executing the game**. It
replaces Clockwork/game-base's `createGameModule`, `getGameModuleConfig`,
`customOperators`, `objectiveDefinitions`, the meta-config schema,
`getInputMapping`, `getVersion` and `requiredForValidation`.

Fields: schema version; `id` (immutable) and `version` (strictly increasing);
`kernel.version` (major pinned; the bundle's embedded kernel constant must
match); genre tags; `session {tickHz, maxTicks, maxWallSeconds, hasEnding}`;
`inputs {map, virtualControls}` from a fixed device vocabulary;
`counters[] {name, type: int, direction, monotonic, label}` with `rankBy` and a
tie policy; `params` (colour, string with allowed values, enum, int with range,
bool); `assets[] {path, sha256, bytes, requiredForSim, license, generator,
moderation}`; budgets; display (orientation, min viewport, aspect);
`capabilities {deterministic, physics, renderer, multiplayer: false, webgpu,
pointerLock}`; rating and content declarations.

Objective evaluation becomes `counters[name] >= threshold`, computed by the
platform. Tribally ignored `customOperators` server-side and hard-coded
operators in SQL, so a new operator needed a code change, a migration and a
seed.

---

## 8. Conformance suite (`@clockwork2/validate`)

Every check is a script in the skill and a job in the submission pipeline. The
platform's own run inside its isolate is the run that decides; a developer's
local run is a convenience.

| # | Check | What it does |
|---|---|---|
| 1 | Determinism | Build twice in one process and once in a fresh isolate; run idle, chaos and a platform-owned generic bot log; compare per-second checkpoint hashes and final counters; under V8, JavaScriptCore and SpiderMonkey |
| 2 | Headless | No `window`, `document`, WebGL, `AudioContext` or `fetch`; `init` + 600 ticks must not throw |
| 3 | Bound | `isOver()` true within `maxTicks` under idle and bot logs |
| 4 | Banned APIs | Static scan of the sim module **and its transitive imports**, plus runtime shims |
| 5 | No async | Lint `await`/`.then`/`async`; hash, drain microtasks, rehash, fail on change |
| 6 | Restore | Snapshot at tick N, restore into a fresh module, continue; must equal continuing without the restore |
| 7 | Budgets | Bundle and each asset against the manifest; every file listed, every hash matching, nothing outside the manifest |
| 8 | Performance | `maxTicks` headless within a per-tick budget, stored as the game's validator factor so budget, isolate CPU cap and cost model agree |
| 9 | Counters | Monotone counters never reverse; `isOver()` never flips back; finite and within 53 bits |
| 10 | Replay round trip | Record through the real recorder, serialise, deserialise, replay, compare; also replay against the previous published version and refuse unless the version was bumped |
| 11 | Manifest + globals | Schema validation; bundle touches no `window.top`, `parent`, `document.cookie`, `XMLHttpRequest` |
| 12 | Render smoke | Headless browser loads the render bundle against a canned state, screenshots for review, confirms no network call leaves the frame except to the asset origin |

Error codes: `E_DETERMINISM_DIVERGED@tick`, `E_LINT_BANNED:<api>@file:line`,
`E_BOUND_NOT_OVER`, `E_RESTORE_MISMATCH@tick`, and so on. The skill's
failure-modes reference is keyed on these.

**Fresh module evaluation per session, not a fresh instance** - tiki-kong's
static id counters survive a fresh instance.

---

## 9. Host bridge

Game document served from a separate origin per game, loaded in
`<iframe sandbox="allow-scripts" allow="autoplay; fullscreen">` **without**
`allow-same-origin` (combining the two lets a same-origin frame remove its own
sandbox). That puts it in an opaque origin.

An opaque origin is same-origin with nothing, so the parent posts with target
origin `*` (or transfers a `MessagePort` on first contact) and checks
`event.source`; the frame checks `event.origin` against the platform origin.

The simulation runs in a worker inside the frame. Workers from an opaque origin
must be `blob:` URLs, so CSP is `worker-src blob:`. `connect-src` must admit
the content-addressed asset CDN - `connect-src 'none'` would block every GLB,
KTX2 and JSON load. The frame has no `localStorage`, IndexedDB or cookies.
Audio unlocks on a tap inside the frame; the parent's gesture does not
propagate.

Messages, host to game: `hello`, `init {seed, config, tickHz}`, `start`,
`pause`, `resume`, `end`, `resize`, `theme`, `virtual-input` (host-drawn mobile
controls are the only source of virtual inputs).

Game to host: `ready {manifestHash, kernelVersion}`, `started`, `progress` (at
most 4 Hz), `checkpoint {tick, hash}`,
`ended {tick, score, reason, finalSnapshot}`, recording chunks, `error`,
`heartbeat`.

It never carries tokens, wallets, balances, prices, URLs, HTML, functions or
other players' data. The handler is a table with no `navigate` row, so adding
one is a visible diff.

---

## 10. The agent skill

Published Agent Skills format. Directory `platform-game/`, name matching the
directory (≤64 chars, lowercase, hyphens), `description` under 1,024 characters
with no XML tags, body under 500 lines, references one level deep, `scripts/`
run through bash so only their output enters context.

```
platform-game/
  SKILL.md              ten rules each naming its machine check; the workflow;
                        the error-code table; the do-not list
  references/           kernel-api (GENERATED from type declarations, never
                        hand-written), manifest-schema, determinism-rules,
                        adapter-canvas2d, adapter-three, physics, assets,
                        failure-modes, submission
  scripts/              validate, run-headless, package, submit, new
  assets/templates/     canvas2d and three starters that pass validate;
                        idle, chaos and bot input logs
  assets/manifest.schema.json
```

Two rules keep it honest. The first line of `SKILL.md` states that where the
prose and `scripts/validate` disagree, the script is right. The skill is pinned
to the SDK major and published with it; a breaking change ships a new skill
directory.

What Clockwork 1's `game-scaffold/CLAUDE.md` gets wrong and this must not
repeat: it hardcodes PIXI and 2D; about 1,000 of its 1,227 lines are 27
techniques copied from six games, which is bulk rather than contract; nothing
is machine-checked; it contradicts itself (technique 22 uses `Math.random()`;
two names for the repaint flag); and it documents a contract the platform never
enforced. An agent following it literally could ship a non-deterministic game,
and snakes-on-a-chain did.

---

## 11. What is copied, what is written fresh

### From Clockwork 1 (`/home/user/clockwork-engine`, core is 45 files / 4,958 lines)

| Source | Fate |
|---|---|
| `PRNG.ts` (68) | Rewritten thin over vendored alea; adds labelled sub-streams, mandatory seed, `exportState`/`importState` |
| `Timer.ts` (209) | Simplified. Fixed steps remove the catch-up loop and the `MAX_ITERATIONS` guard, because a step is always one tick |
| `Serializer.ts` (214) | Survives as canonical encoder; the module-level singleton at line 214 becomes a per-session registry |
| `EventEmitter.ts` (26) | Copied as is |
| `GameRecorder` (130), `ReplayManager` (271) | Replaced. The loop produces the recording; replay **is** the loop fed a recorded input source. The `Proxy` goes |
| `GameObject` (342), `GameObjectGroup` (170) | Not in the kernel. Games implement `tick()` directly, so the object-group update pass is unreachable from game code - which is what stops tiki-kong's and tiki-jump's double-update-per-tick. Returns later as an optional library for ported games |
| `Vector2D` (150), `CollisionGrid` (128), `GeometryUtils` (193) | Not in this milestone. A 2D helper package when a 2D game needs it |
| `AssetLoader` (209), `Spritesheet` (103), `Loader`, `HeadlessLoader` | Replaced by manifest `assets[]` plus a host-supplied asset bag |
| `GameCanvas` (427), `AbstractRenderer` (406), `DisplayNode` (243), all `platform/*` | Dropped |

Note: core is already DOM-free and PIXI-free at runtime; the coupling is
structural. The single platform tie in the determinism core is
`GameEngine.ts:56-62` constructing an `AssetLoader` from
`platform.rendering`/`platform.audio`. Also `BaseRenderer` is documented in
Clockwork 1's `CLAUDE.md` but does not exist in the code - do not port it.

### From game-base (`/home/user/game-base`, src is 53 files / 5,078 lines)

Only about 780 lines are portable; 2,959 are a React demo harness and 633 are
Node CLI tooling.

| Source | Fate |
|---|---|
| `recording/` (294, already isomorphic) | Ported. The envelope's `version` is written but never checked on decode; Clockwork 2 checks it and has a stated migration path |
| Counter evaluation in `objectives/validators.ts` + `formatters.ts` (~130) | Ported as `counters.ts`. Every core operator is `snapshot[key] >= threshold`, which is a manifest row, not code |
| `metaConfig.ts` (315, zero imports) | Becomes the manifest `params` validator. Its 1,622-line test file is reused as the conformance corpus |
| `types.ts` `GameInputMapping` | Already JSON-serialisable; drops into manifest `inputs` verbatim, with the key type widened from the closed 15-member `GameIntent` enum to per-game strings |
| Determinism diff in `demo-template/hooks/useHeadlessValidation.ts` | Extracted into `@clockwork2/validate`, minus the React wrapper |
| Intent dispatch in `KeystrokesInputManager` (258) | Policy half ported to host-side input capture; the `@rwh/keystrokes` binding half is an adapter |
| `payoutCalculator.ts` (82), `CORE_OBJECTIVE_METADATA`, `createGameModule.ts` (129), `demo-template/`, `cli/` | Dropped |

---

## 12. Milestones

Each is a PR. M2 is where the design is first proven rather than asserted.

- **M0 Bootstrap.** Workspace, Biome, tsconfig, one shared build script
  (Clockwork 1 has three near-identical copies), a single `.versionrc.json`
  (Clockwork 1 has two, one stale with hardcoded upstream URLs), CI skeleton,
  MIT LICENSE, NOTICE, README, `docs/differences.md`, CLAUDE.md.
- **M1 Kernel.** Every module in section 5, with tests. Ends with a toy game
  running headlessly under Bun and Node producing matching hashes.
- **M2 Validate.** The twelve checks, the error-code table, the CLI. Ends with
  record, serialise, replay and hash-compare working end to end.
- **M3 Host bridge.** Parent and frame halves, opaque-origin iframe, `blob:`
  worker, the message table with no `navigate` row, the accumulator loop,
  host-side input capture.
- **M4 Adapters.** `adapter-canvas2d` then `adapter-three`, each read-only,
  each driven by `render(view, previousView, alpha, dtMs)`.
- **M5 Skill.** `SKILL.md`, references, scripts, and canvas2d and three
  templates that pass `validate` on the first run.
- **M6 CI and release.** Three-engine conformance wired up, token-based publish
  rather than Clockwork 1's interactive OTP prompt, and a release gate -
  Clockwork 1's root `.versionrc.json` has no `prerelease` hook, so a release
  can be cut from a red tree.

---

## 13. Verification

- `bun test` per package; the kernel's determinism suite is the gate.
- **Cross-engine golden vectors.** `dmath`, the state hash and the PRNG produce
  a fixed vector file. CI runs it under Node (V8), Bun (JavaScriptCore) and
  Firefox via Playwright (SpiderMonkey) and fails on any byte difference. This
  is the check that matters most, because everything else assumes it holds.
- **alea parity.** Golden vectors taken from `alea@1.0.1` itself, asserting the
  vendored copy is byte-identical in output.
- **Record-and-replay round trip** on the template games: record in a real
  browser through the host bridge, replay headlessly, compare per-second
  checkpoint hashes and final counters.
- **Restore-then-continue equals continue**, at several tick offsets, including
  PRNG state.
- **The shims fire.** A deliberately non-conformant fixture calling
  `Math.random`, `Date.now` and `Math.pow` must fail `validate` with the exact
  error codes, so the failure-modes reference stays true.
- **Manifest validator** against game-base's 1,622-line metaConfig corpus.
- `bun run lint` and a clean `bun run build` in every package.

---

## 14. Work already done (not pushed)

Historical. The handoff was written from a session that could not push to
`vbz-gg/clockwork2`. That is resolved: this repository is the result.


## 15. Open questions, carried not resolved

- Whether Playwright's Firefox is fast enough for the determinism sweep, or
  whether CI needs a `jsvu` SpiderMonkey shell. Decide by measurement in M6.
- The 128 MB Workers-for-Platforms isolate ceiling against a 3D simulation is
  unmeasured. It does not block this repo, but it constrains what the manifest
  budgets should allow, so M1 should leave budget fields advisory.
- Physics stays out. Custom kinematics only in year one; the deterministic
  Rapier build (`@dimforge/rapier2d-deterministic`, not the default package,
  which has been non-deterministic since rapier.js 0.15.0) is a later package
  and only after a two-machine hash test.
- Porting snakes-on-a-chain, tiki-kong and tiki-jump needs `adapter-pixi` and a
  compat package, both out of scope here. Their re-tuning cost is real:
  tiki-kong and tiki-jump step every object twice per tick and are tuned that
  way.
