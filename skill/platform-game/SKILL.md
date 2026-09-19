---
name: platform-game
description: Build a browser game on Clockwork 2 that the arcade can verify - fixed-step ticks, seeded randomness, an input log that replays to the same state on a server. Use when writing or reviewing a game module, a manifest, a renderer or a recording; when a conformance check fails with an E_ code; or when porting a variable-step game onto the fixed-step contract. Covers the simulation and renderer boundary, deterministic maths, snapshots and restore, counters and objectives, budgets, and the twelve checks in @clockwork2/validate.
---

# Building a verifiable game

**Where this file and `scripts/validate.sh` disagree, the script is right.** It
is what the platform runs. Prose cannot fail a build.

The arcade pays and ranks on results, so a score has to be something the
platform can verify rather than trust. The browser records the player's inputs,
the server replays them, and both sides must reach the same state - on V8,
JavaScriptCore and SpiderMonkey alike. Everything below follows from that one
sentence.

## Start here

```bash
scripts/new.ts ./my-game                    # canvas2d
scripts/new.ts ./my-game --renderer=three
cd ./my-game && bun install
bun run validate                            # passes before you change anything
```

Start from a template rather than from an empty directory. The template
conforms on its first run, so any failure after that is something you just
did, which is a far shorter thing to debug than a game that has never passed.

## The shape of a game

```
src/sim.ts        the simulation - rules apply here and nowhere else
src/manifest.ts   data the platform reads without running anything
src/index.ts      the bundle's entry: default export + MANIFEST
src/present.ts    the renderer - no rules beyond "read, never write"
src/main.ts       the page: wires the host bridge to a container
```

`index.ts` must not import `present.ts`. The import graph is scanned
transitively, and a simulation that can reach a canvas is a simulation that
can decide a score from one.

A game implements `GameModule`: `init`, `tick`, `view`, `snapshot`, `restore`,
`score`, `isOver`, `effects`. The full signatures are in
`references/kernel-api.md`, which is generated from the type declarations.

## The ten rules

Each names the check that enforces it. Run `scripts/validate.sh ./src` to run
all twelve checks; `--only=name` runs one.

**1. `tick()` advances exactly one tick and takes no delta.**
A fixed step is what makes a simulation independent of the player's frame
rate. The host owns an accumulator over `requestAnimationFrame`: a slow frame
runs more ticks, never a bigger one. Jitter changes *how many* ticks run and
never *how big* a tick is.
*Checked by `determinism`; proved end to end by the frame-rate spec in this
repository's e2e suite.*

**2. Randomness comes from a seeded `Prng`, in labelled sub-streams.**
`new Prng(seed)` in `init`, then `rng.stream("spawn")`. With one stream, adding
a draw to the spawn logic shifts every later loot roll and silently changes
every recorded session.
*Checked by `banned-apis`, `determinism`.*

**3. Transcendentals come from `dmath`. `Math.pow` and `**` are banned.**
`Math.cos(0.1)` is `0x3FEFD712F9A817C1` on JavaScriptCore and
`0x3FEFD712F9A817C0` on V8. One bit, once, and the state hash differs and the
replay is rejected. Use `dmath.ipow` for integer exponents; it is exact.
*Checked by `banned-apis`.*

**4. Time is the tick count. `Date`, `performance.now` and the timer functions
are banned.**
Scheduled work uses `Timer`, which counts in ticks and snapshots cleanly.
*Checked by `banned-apis`.*

**5. Nothing async.** `tick()` may not be `async` or return a thenable. No
`await`, no `.then`, no `queueMicrotask`. Anything that needs to wait belongs
in the host.
*Checked by `no-async`.*

**6. `snapshot()` holds everything, and `restore()` puts it all back.**
The test is not whether it looks complete: it is whether restoring at tick N
and continuing reaches the same state as never having stopped. Forgotten most
often, in order: the PRNG state, the timer state, an id counter, a cooldown,
the config.
*Checked by `restore`, at several offsets.*

**7. The run ends inside `maxTicks`** - under an idle player, under chaos
input, and under the platform's bot. "The player can quit" is not an ending;
the idle log is a player who does not.
*Checked by `bound`.*

**8. Counters are declared, integer, and honest.** A counter declared
`monotonic` never moves the wrong way and `isOver()` never goes back to false.
Objectives are `counters[name] >= threshold`, computed by the platform, so a
new kind of objective is a new counter rather than new code.
*Checked by `counters`.*

**9. The renderer reads and never writes**, and `view()` returns
structured-cloneable plain data - no class instances, no functions - because
in worker mode it is cloned across a thread boundary.
*Checked by `headless`, `render-smoke`.*

**10. No browser inside the simulation.** `init` plus 600 ticks must run with
no `window`, `document`, WebGL, `AudioContext` or `fetch` present.
*Checked by `headless`.*

## What the renderer may do

Everything rules 2 to 5 forbid. `Math.random`, `Math.sin`, `performance.now`,
the DOM, WebGL, audio, the network, Three's `Quaternion` and `Clock`. None of
it is read back by the simulation, so none of it can change a result.

Interpolate with `alpha` - how far this frame sits between the last tick and
the next. A renderer that ignores it judders on any display whose rate is not
a multiple of the tick rate.

Sounds are `Effect` values returned from `effects()` and drained by the host,
not calls inside `tick()`. A frame that runs two ticks would otherwise play
the sound twice, and a headless replay would have to stub the call.

## Workflow

1. `scripts/new.ts ./my-game` - a conforming starting point.
2. Write the simulation in `src/sim.ts`. Read
   `references/determinism-rules.md` first; it is the whole rulebook and it is
   short.
3. `scripts/validate.sh ./src` after each meaningful change, not once at the
   end. A determinism bug found three edits after it was written is a
   different job from one found three weeks after.
4. `scripts/run-headless.ts ./src` to see what a session actually looks like -
   how long it runs, what the checkpoints are, whether it ends on its own.
5. Write the renderer. It has no rules beyond reading, so leave it until the
   simulation conforms.
6. `scripts/package.ts ./dist --manifest=./src/manifest.ts` before shipping:
   every file declared, every hash matching.

## When a check fails

Every failure carries a stable code - `E_RESTORE_MISMATCH@1380`. Look it up in
`references/failure-modes.md`, which has a section per code with the causes in
the order they actually turn up. Read the code, never the message: messages
are prose and change.

The three that account for most failures:

- `E_LINT_BANNED` - a banned API in the import graph. The tag names the file,
  line and column.
- `E_RESTORE_MISMATCH` - a field missing from the snapshot.
- `E_BOUND_NOT_OVER` - the game does not end by itself.

## Do not

- Do not add a "deterministic mode" flag. There is one mode.
- Do not seed a generator from the clock, the URL, or a device property.
- Do not put a wall-clock timestamp in the state, not even for a log line.
- Do not sort to paper over an ordering bug. A comparator returning 0 for
  items that are not equal leaves their order to the engine's sort.
- Do not iterate a plain object's keys where order matters. Integer-like keys
  come first in ascending numeric order, whatever the insertion history.
- Do not hold DOM nodes, sockets, or anything with an identity in simulation
  state.
- Do not let the renderer write to the view, or to anything the simulation
  reads.
- Do not change simulation behaviour without bumping `version`. Every score
  already recorded becomes unverifiable, silently.
- Do not build an input event inside the game. The host builds them; a game
  that could make its own could do its hit-testing in the renderer and hand
  the answer to the simulation, which replays perfectly and still decides the
  result on the client.

## References

- `references/determinism-rules.md` - the rules, with what is allowed and why.
- `references/failure-modes.md` - one section per error code.
- `references/kernel-api.md` - the API, generated from the type declarations.
- `references/manifest-schema.md` - every manifest field and what it decides.
- `references/adapters.md` - canvas2d, three, pixi, `NodeSet`, effects,
  worker mode.
- `references/assets.md` - declaring, hashing and loading files.
- `references/submission.md` - what a recording contains and what the platform
  verifies.

## Scripts

- `scripts/validate.sh <path>` - the twelve checks. The authority.
- `scripts/run-headless.ts <path>` - run a session with no browser and print
  its checkpoints.
- `scripts/package.ts <dir> [--manifest=]` - hash assets and check the
  manifest declares them.
- `scripts/new.ts <dir> [--renderer=]` - a conforming starting point.
