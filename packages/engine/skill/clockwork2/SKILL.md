---
name: clockwork2
description: Build a browser game on Clockwork 2 that a platform can verify - fixed-step ticks, seeded randomness, an input log that replays to the same state on a server. Use when writing or reviewing a game module, a manifest, a renderer or a recording; when a conformance check fails with an E_ code; or when porting a variable-step game onto the fixed-step contract. Covers the simulation and renderer boundary, deterministic maths, snapshots and restore, counters and objectives, declared inputs and what to record, data packs, budgets, and the conformance checks in @clockwork2/engine/validate. Holds for a game on the engine alone and for the simulation of one built with the vbz kit.
---

# Building a verifiable game

**Where this file and `scripts/validate.sh` disagree, the script is right.** It
runs the engine's eleven checks every game needs, and with `--ranked` the two
a ranked or practice run needs; a platform may run more. Prose cannot fail a
build.

A platform ranks on results, so a score has to be something it can verify
rather than trust. The browser records the player's inputs,
the server replays them, and both sides must reach the same state - on V8,
JavaScriptCore and SpiderMonkey alike. Everything below follows from that one
sentence. The rules bind every session, including a game played only on its
own page, except the few under "Ranked and practice runs", which bind only the
runs a platform serves.

## Where the commands run

This guide ships inside the `@clockwork2/engine` package, at
`skill/clockwork2/`, so a game that installs the engine has a copy at
`node_modules/@clockwork2/engine/skill/clockwork2/`. An agent's tools may
install it somewhere else. `<guide>` in a command is the directory this file
is in, wherever that is, and a name such as `scripts/package.ts` is a file in
it.

Run every command from the game's own root. The scripts load the engine out of
the game's `node_modules`, so a game is checked against the engine it pins
rather than the copy this guide came with, and `validate.sh` calls `bunx`,
which finds the game's `clockwork2-validate` only from there.

Where a command says `./src`, give it the directory holding the simulation's
entry, the `index.ts` with the default export and `MANIFEST`. That is `./src`
in a game made from this guide's templates and `./src/sim` in one built with
the vbz kit.

## Start here

A game on the engine alone starts from one of this guide's templates.
`new.ts` makes the game's directory, and everything after it runs from inside:

```bash
<guide>/scripts/new.ts ./my-game                    # canvas2d
<guide>/scripts/new.ts ./my-game --renderer=three
cd ./my-game && bun install
bun run validate                                    # passes before you change anything
```

Start from a template rather than from an empty directory. The template
conforms on its first run, so any failure after that is something you just
did, which is a far shorter thing to debug than a game that has never passed.

`scripts/new.ts` and the two templates exist for a game on the engine alone,
and are not copied into a vbz game. A game built with the vbz kit starts from
the kit's own scaffold, as the kit's guide describes, and everything else here
applies to its simulation unchanged. It has no `bun run validate`; where this
guide says that, run `<guide>/scripts/validate.sh ./src/sim` from the game's
root.

## The shape of a game

A game made from the templates:

```
src/sim.ts        the simulation - rules apply here and nowhere else
src/manifest.ts   data the platform reads without running anything
src/index.ts      the bundle's entry: default export + MANIFEST
src/present.ts    the renderer - no rules beyond "read, never write"
src/main.ts       the page: runs the host, and decides which keys and fingers
                  drive the declared inputs
```

A vbz game has the same parts under the names its kit gives them, with the
entry at `src/sim/index.ts` and the renderer under `src/present/`.

`index.ts` must not import `present.ts`, and in a vbz game the entry must not
reach `src/present/`. The import graph is scanned transitively, and a
simulation that can reach a canvas is a simulation that can decide a score
from one.

A game implements `GameModule`: `init`, `tick`, `view`, `snapshot`, `restore`,
`score`, `isOver`, `effects`. A game that reads data it ships as files also
implements `packsNeeded`, and `init` hands it the reader; `references/assets.md`
covers both. A game whose players take turns declares `session.seats` and
implements `seat()`, which says whose turn each tick is;
`references/seats.md` covers that. The full signatures are in `references/kernel-api.md`, which is
generated from the type declarations.

## The nine rules

Each names the check that enforces it. Run `<guide>/scripts/validate.sh ./src`
to run all eleven checks; `--only=name` runs one.

1. **`tick()` advances exactly one tick and takes no delta.** A fixed step is
   what makes a simulation independent of the player's frame rate. The host
   owns an accumulator over `requestAnimationFrame`, so a slow frame runs more
   ticks rather than bigger ones. Jitter changes how many ticks run and never
   how big one is.
   *Checked by `determinism`, and end to end by the engine's frame-rate tests,
   which replay one log at rates from 240 Hz to 5 Hz.*

2. **Randomness comes from a seeded `Prng`, in labelled sub-streams.**
   `new Prng(seed)` in `init`, then `rng.stream("spawn")`. With one stream,
   adding a draw to the spawn logic shifts every later loot roll and silently
   changes every session anyone already recorded.
   *Checked by `banned-apis` and `determinism`.*

3. **Transcendentals come from `dmath`. `Math.pow` and `**` are banned.**
   `Math.cos(0.1)` is `0x3FEFD712F9A817C1` on JavaScriptCore and
   `0x3FEFD712F9A817C0` on V8. One bit in one cosine moves the state hash, and
   the replay is rejected. Use `dmath.ipow` for an integer exponent; it is
   exact.
   *Checked by `banned-apis`.*

4. **Time is the tick count.** `Date`, `performance.now` and the timer
   functions are banned. Scheduled work uses `Timer`, which counts in ticks and
   snapshots cleanly.
   *Checked by `banned-apis`.*

5. **Nothing async.** `tick()` may not be `async` or return a thenable. No
   `await`, no `.then`, no `queueMicrotask`. Anything that has to wait belongs
   in the host. Data the simulation reads ships as a data pack: the host
   fetches it, and the kernel hands it over at the step `packsNeeded()` names,
   so a slow download changes how long the loop waits and never what it
   computes.
   *Checked by `no-async`.*

6. **`snapshot()` holds everything, and `restore()` puts it all back.** The
   test is whether restoring at tick N and continuing reaches the same state as
   never having stopped. The fields people leave out, in order: the PRNG state,
   the timer state, an id counter, a cooldown, the config.
   *Checked by `restore`, at several offsets.*

7. **Counters are declared, integer, and honest.** A counter declared
   `monotonic` never moves the wrong way and `isOver()` never goes back to
   false. Objectives are `counters[name] >= threshold`, computed by the
   platform, so a new kind of objective is a new counter rather than new code.
   *Checked by `counters`.*

8. **The renderer reads and never writes.** `view()` returns
   structured-cloneable plain data, with no class instances and no functions,
   because in worker mode it is cloned across a thread boundary.
   *Checked by `headless` and `render-smoke`.*

9. **No browser inside the simulation.** `init` plus 600 ticks must run with
   no `window`, `document`, WebGL, `AudioContext` or `fetch` present. Packs
   come through the reader `init` is given, never through `fetch`.
   *Checked by `headless`.*

No rule says how long a run lasts. A session runs until `isOver()` turns true
or its host stops it; there is no step limit, and `session.hasEnding` in the
manifest describes the game and nothing reads or checks it. The checks play each log to
its end or to 36,000 ticks (`CHECK_WINDOW_TICKS`), and the `determinism` line
of the report says where every run stopped, which is how to see that a game
meant to end by itself does.

## Ranked and practice runs

A platform built on the engine serves some runs itself. It hands the page a
seed and a config, replays the recording on its server, and for a ranked run
ranks what the replay computed. Those runs carry rules of their own that a
game played only on its own page does not need. Determinism is not one of
them: the nine rules above bind every session, wherever it runs.
`<guide>/scripts/validate.sh ./src --ranked` adds the two checks below.

- **The seed changes the game.** Two seeds played over the same inputs pass
  through different states, at some checkpoint, on at least one of the idle,
  chaos and bot logs, or every seed the platform serves plays the same game.
  Runs that all end alike are fine.
  *Checked by `seed-sensitivity`, in the ranked set.*
- **The manifest says how a run ranks**, with both `rankBy` and `tiePolicy`.
  *Checked by `ranking`, in the ranked set.*
- **The run plays the config the platform serves**: every parameter the
  manifest declares, at its default, which `servedConfig(manifest)` builds. A
  player never picks it. Every check plays the same config, so what passed the
  checks is what a run plays.
  *Every check plays it: `loadSubject` gives it to the suite.*
- **At most `INPUT_BUDGET_PER_TICK`, 16, inputs a tick on average.** A
  platform holds every log it replays to the budget with `checkInputs`; a page
  that records only changes, in the coarsest range the game needs, stays far
  under it. `references/inputs.md` has the measurements.
  *Held by the platform, with `checkInputs`.*
- **Inputs come only from the device helpers**, with `InputCapture`'s
  `scripted: "ignore"`, so an event a script dispatches on the page is never
  recorded as the player's. A game played on its own page may record its
  inputs itself, or set `scripted: "record"`.
  *Held by the page a platform's kit builds, which sets it.*

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

Each command runs from the game's own root.

1. `<guide>/scripts/new.ts ./my-game` - a conforming starting point for a game
   on the engine alone. A vbz game starts from its kit's scaffold instead.
2. Write the simulation, in `src/sim.ts` in a game made from the templates.
   Read `references/determinism-rules.md` first; it is the whole rulebook and
   it is short. Declare the inputs `tick` reads in the manifest as you go;
   `references/inputs.md` says how to keep what they record small.
3. `<guide>/scripts/validate.sh ./src` after each meaningful change, not once
   at the end. A determinism bug found three edits after it was written is a
   different job from one found three weeks after. Add `--ranked` for a game a
   platform will rank.
4. `<guide>/scripts/run-headless.ts ./src` to see what a session actually
   looks like - how long it runs, what the checkpoints are, whether it ends on
   its own.
5. Write the renderer. It has no rules beyond reading, so leave it until the
   simulation conforms.
6. `<guide>/scripts/package.ts ./dist --manifest=./src/manifest.ts` before
   shipping: every file declared, every hash matching.

## When a check fails

Every failure carries a stable code - `E_RESTORE_MISMATCH@1380`. Look it up in
`references/failure-modes.md`, which has a section per code with the causes in
the order they actually turn up. Read the code, never the message: messages
are prose and change.

The two that account for most failures:

- `E_LINT_BANNED` - a banned API in the import graph. The tag names the file,
  line and column.
- `E_RESTORE_MISMATCH` - a field missing from the snapshot.

## Never

- A "deterministic mode" flag. There is one mode.
- Seeding a generator from the clock, the URL, or a device property.
- A wall-clock timestamp in the state, not even for a log line.
- Sorting to paper over an ordering bug. A comparator that returns 0 for items
  which are not equal leaves their order to the engine's sort.
- Iterating a plain object's keys where order matters. Integer-like keys come
  first in ascending numeric order, whatever the insertion history.
- DOM nodes, sockets, or anything else with an identity in simulation state.
- A renderer that writes to the view, or to anything the simulation reads.
- Changing simulation behaviour without a new `version`. Every score already
  recorded becomes unverifiable, and nothing announces it.
- Shipping a rules change as a patch. A patch promises the same play scores
  the same; `references/manifest-schema.md` under "Versioning" says which
  changes need a minor.
- Deciding a hit in the page and recording the answer. Record where the
  finger was and hit-test in `tick()`: an answer worked out in the page
  replays perfectly while the result was decided where nothing checks it.
- Recording a stream of readings. Record a value when it changes, in the
  coarsest range the game needs; `references/inputs.md` has the rules.

## References

- `references/determinism-rules.md` - the rules, with what is allowed and why.
- `references/failure-modes.md` - one section per error code.
- `references/kernel-api.md` - the API, generated from the type declarations.
- `references/manifest-schema.md` - every manifest field and what it decides.
- `references/inputs.md` - declaring inputs, choosing what to record, and the
  device helpers.
- `references/seats.md` - players who take turns in one run: `seats`,
  `seat()`, the page that follows another seat's turn, and the server that
  merges their inputs.
- `references/adapters.md` - canvas2d, three, pixi, `NodeSet`, effects,
  worker mode.
- `references/assets.md` - declaring, hashing and loading files, and the data
  packs the simulation reads.
- `references/submission.md` - what a recording contains and what the platform
  verifies.

## Scripts

Each runs from the game's own root, as `<guide>/scripts/...`.

- `<guide>/scripts/validate.sh <path> [--ranked]` - the engine's eleven checks
  every game needs, and with `--ranked` the two a ranked or practice run needs;
  a platform may run more. The authority on those checks.
- `<guide>/scripts/run-headless.ts <path>` - run a session with no browser and
  print its checkpoints.
- `<guide>/scripts/package.ts <dir> [--manifest=]` - hash assets and check the
  manifest declares them.
- `<guide>/scripts/new.ts <dir> [--renderer=]` - a conforming starting point
  for a game on the engine alone, from one of this guide's templates.
