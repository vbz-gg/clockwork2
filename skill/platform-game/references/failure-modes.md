# Failure modes

One section per error code, keyed exactly on the code. `skill/tests/skill.test.ts`
fails when this file and the kernel's `ERROR_CODES` table disagree, in either
direction, so a code with no section here cannot ship and a section for a code
that no longer exists cannot linger.

Read the code, not the message. Messages are prose and change; a code is a
promise. Catching code switches on `error.code`, never on a substring of
`error.message`.

Where this file and `@clockwork2/engine/validate` disagree, the validator is right.

## Runtime, inside the kernel

### E_ASYNC_TICK

`tick()` returned a thenable. Usually `async tick()` where the `async` was not
needed, or a `tick` that returns the result of an `await`-free helper which is
itself `async`.

There is no asynchronous version of this. Anything that needs to wait belongs
in the host: data the simulation reads ships as a pack, which the host loads
and the kernel hands over at a step the game names; small settings arrive as
config; anything else is an effect the host acts on.

### E_BANNED_API

A shimmed global was touched during `init()` or `tick()`. The detail names it.

The remedy is per API: `Math.random` becomes `Prng`, `Date.now` and
`performance.now` become the tick count, `setTimeout` becomes `Timer`,
`Math.sin` and the rest become `dmath`. See `determinism-rules.md` for the
whole table.

This fires at the point of use, so the stack is the answer. If it fires from a
library you did not write, that library is not usable in a simulation - move
the call to the renderer or replace it.

### E_SEED_REQUIRED

`new Prng()` with no seed. There is no unseeded path on purpose: a generator
that seeds itself is a generator whose stream nobody can reproduce.

Take the seed from `init(seed)` and derive everything else from it with
`prng.stream(label)`.

### E_DMATH_RANGE

A `dmath` routine was handed an argument outside the range it can reduce
exactly - in practice an angle of a few quadrillion radians, which almost
always means an accumulator that was never wrapped.

Wrap it: `dmath.wrapAngle(angle)` each tick, or keep the angle as a fraction
of a turn and multiply only when you need it. A sentinel is not returned
because `NaN & 3` is `0` and the caller would compute a plausible wrong answer
from it.

`dmath.exp2i()` reports the same code for an exponent outside `[-1022, 1023]`,
where two to the power of it is not a normal double.

### E_CANONICAL_UNSUPPORTED

`snapshot()` returned a value with no canonical encoding: `NaN`, `Infinity`,
`undefined`, a function, a `Map`, a `Set`, a `Date`, or an instance of one of
your own classes.

A snapshot is plain data. Convert on the way out and back on the way in: a
`Map` becomes a sorted array of pairs, a class instance becomes an object
literal, an `undefined` field is left out rather than written. `NaN` and
`Infinity` are usually a division that should have been guarded, and encoding
them would hide the bug rather than fix it.

`-0` is kept distinct from `0`, deliberately. If that surprises you, the
surprise is worth having: they are different bit patterns and a hash that
conflated them would call two different states equal.

### E_COUNTER_REVERSED

A counter the manifest declares `monotonic` went the wrong way.

Either the counter really can go down, in which case the manifest is wrong and
`monotonic` should be false, or something is resetting it - a restore that
forgot a field, or a score recomputed from a list that was pruned.

### E_COUNTER_RANGE

A counter was not a finite integer within 53 bits. A float that happens to be
whole is still a float: `Math.floor` it in `score()`.

### E_OVER_FLIPPED

`isOver()` returned true and then false. A session that can un-end cannot be
scored, because there is no moment the score is final.

Keep a boolean field that is only ever set, never cleared - and make sure
`restore()` restores it.

### E_TICK_LIMIT

The session passed the `maxTicks` its manifest declares without `isOver()`
becoming true. The kernel ends the run; this is the code it ends it with.

If that is legitimate - an endless game - the manifest says `hasEnding: false`
and `maxTicks` is the intended length. If it is not, see `E_BOUND_NOT_OVER`.

### E_INPUT_UNSORTED

An input log was not sorted by tick. Recordings come out sorted; a log built by
hand may not be. Sort it by tick, keeping the original order within a tick,
which is the order the host would have produced.

### E_INPUT_RANGE

An input value fell outside what the device vocabulary allows. Analog axes are
quantised integers, not floats in [-1, 1]; use `quantiseAxis` rather than
inventing a scale.

### E_RECORDING_VERSION

A recording's `format` or `version` is not one this kernel reads. It is
refused rather than guessed at: a recording is evidence, and a codec that
silently reinterprets old evidence produces confident wrong answers.

Replay it with the kernel version it was recorded on.

### E_RECORDING_MALFORMED

A recording failed its structural checks - a missing field, an input log that
is not an array, an `endTick` before the last input. Usually a hand-edited
file or a truncated upload.

### E_MANIFEST_INVALID

The manifest failed `assertManifest`. The detail names the field. Common ones:
a `tickHz` that is not 30, 60 or 120; `rankBy` naming a counter that is not
declared; `capabilities.deterministic` not `true`.

### E_ARG_INVALID

An argument the caller controls was outside the range the API accepts, and the
detail names the value and the range. The APIs that report it are `maxTicks`
and `tickHz` on a session, the tick counts `Timer.every()` and `Timer.after()`
take, the replay speed on a host, `fixed.div()` by zero, `fixed.sqrt()` of a
negative, `randomChoice()` on an empty array, and `dmath.copysign()` with a NaN
in either argument.

This is a bug in the calling code rather than a state the engine puts you in,
so there is nothing to catch and nothing to recover. Read the detail and fix
the call.

`copysign` is the one that needs a word of its own, because refusing a NaN
there is not obvious. A NaN's sign bit is chosen by the processor, not by
ECMAScript, so `copysign` would hand you a *finite* number that differs between
an x86 player and an arm64 one, and the canonical encoder would accept it.
Reaching it means the simulation already produced a NaN somewhere, so the fix
is upstream of the call.

### E_ENV_UNSUPPORTED

The host cannot supply something the engine needs. Two places report it. The
kernel probes the word order of a double when it loads and refuses a platform
whose layout it does not recognise, because every hash below it reads those
bytes directly. The canvas2d adapter reports it for a canvas that returns no
2d context.

Neither is something a game can fix. A platform that fails the first is not one
this engine runs on. The second is a browser without canvas support, or a
canvas already holding a context of another kind.

### E_PACK_UNDECLARED

The game named a pack the manifest does not declare with
`requiredForSim: true`: in `packs.open` or `packs.json`, in what
`packsNeeded()` returned, or in a `prefetch` effect. A host that delivers an
undeclared path gets it too.

A pack outside the manifest is outside the manifest hash, so no recording
could say which bytes the run read. Declare it in `assets`, with its `sha256`
and `bytes`, and `requiredForSim: true`. Art the renderer loads is not a pack
and is never read through the reader.

### E_PACK_NOT_REQUESTED

The game read a pack at a point it had not asked for it. The detail says
which of three it was:

- a demand pack read in a tick that `packsNeeded()` did not name it for, just
  before that tick;
- a demand pack read in `init` or `restore`, which can read start packs only;
- any pack read outside `init`, `restore` and `tick`: from `view`,
  `snapshot`, `score`, `isOver` or `packsNeeded` itself.

Each of these would make the run depend on when the bytes happened to arrive,
which differs between a fast host, a slow one and a server. Name the pack in
`packsNeeded()` for every tick that reads it. Keep parsed pack data out of the
snapshot and open it again on the first tick after a restore. Copy what the
renderer needs into `view()`'s state rather than reading a pack there.

### E_PACK_NOT_DELIVERED

A pack the session needs was not handed over. A start pack was missing when
the session was built, or a tick could not run because a pack
`packsNeeded()` named for it never arrived. A session started with no
`assets` at all reports this for any pack the game reads.

This is the host's or the platform's to fix rather than the game's: the file
is missing from the bundle, the loader could not fetch it, or the caller did
not pass the manifest's `assets` and packs to `runSession`. In the
conformance suite it means a declared pack is not in the bundle's directory;
the budgets check reports the same file as `E_BUDGET_EXCEEDED`.

### E_PACK_HASH_MISMATCH

A pack's bytes are not the ones its manifest entry declares: the SHA-256
differs, or the file is shorter than `bytes`. Also reported when a set of
packs checked against one version of a manifest is given to a session of
another.

The manifest entry and the file have drifted apart. Rebuild the entry from
the file; `scripts/package.ts` prints it.

### E_PACK_TOO_LARGE

A pack is longer than the `bytes` its manifest entry declares. The kernel
checks the size before it hashes anything, and a host's fetch stops reading
as soon as the size is passed, so an oversized file is refused without being
read whole.

Rebuild the entry from the file. If the file is right and the entry is right,
something between them is adding bytes: a server rewriting the response, for
example.

## The conformance suite

### E_DETERMINISM_DIVERGED

Two runs of the same seed, config and input log reached different states. The
tick is in the tag: `E_DETERMINISM_DIVERGED@1380`.

Work backwards from that tick. The usual causes, in the order they turn up:
iteration over a plain object's keys where the insertion history differs;
a `Set` or `Map` built in an order that depends on something outside the
simulation; sorting with a comparator that returns 0 for items that are not
equal; reading a module-level variable that the previous session left behind.

That last one is why the platform evaluates the module afresh per session
rather than taking a fresh instance: a fresh instance does not reset a
module-level counter.

### E_HEADLESS_THREW

The module threw when loaded or stepped with no browser present. Almost always
a top-level `document`, `window`, `AudioContext` or `fetch` - often inside an
import that looked harmless.

The simulation's entry must not import the renderer. That one rule prevents
most of this.

### E_BOUND_NOT_OVER

`isOver()` never became true inside `maxTicks`, under the idle, chaos or bot
log. The platform has to bound what it pays to replay, so an unbounded game
cannot be accepted.

Add the ending: a time limit, a difficulty ramp that eventually beats any
player, a life count. "The player can always quit" is not an ending - an idle
player never quits, and the idle log is exactly that player.

### E_LINT_BANNED

The static scan found a banned API in the simulation's import graph. The tag
carries where: `E_LINT_BANNED:Math.random@src/spawn.ts:42:18`.

The scan follows imports transitively, so this fires for a dependency as well
as for your own code. `@clockwork2/*` packages are trusted and not scanned.

The scan and the runtime shims are two layers. A scan misses an aliased
global, `sendBeacon`, `new Image().src` and dynamic import; a shim misses a
path that never ran. Both have to be clean.

### E_ASYNC_DETECTED

`await`, `async` or `.then` appears in the simulation, or a state hash changed
after microtasks drained.

The second half is the one worth explaining: the check hashes the state,
drains the microtask queue, and hashes again. If the two differ, something was
scheduled during a tick and settled after it, which means the state depends on
when the host happened to look.

### E_RESTORE_MISMATCH

Snapshot at tick N, restore into a fresh module, continue - and the result
differed from never having stopped. The tag carries the tick.

Nearly always a field missing from `snapshot()`. The candidates, in the order
they are usually forgotten: the PRNG state, the timer state, an id counter, a
cooldown, a cached derived value, and the config itself.

Two subtler ones. A sub-stream opened *after* the snapshot is seeded from the
root's seed, so the root's seed has to be in the state - it is, but only if
you export the root and not just its children. And `restore()` has to rebuild
anything that holds a function: a timer restores names, not closures, so
`init()` runs first to define the handlers and `restore()` then imports the
state over the top.

### E_BUDGET_EXCEEDED

A declared asset is missing from the bundle, its bytes do not hash to the
declared `sha256`, its length is not the declared `bytes`, or the declared
assets together are over `budgets.assetBytes`. The check reads only declared
files: a file the manifest does not mention is not reported, and
`budgets.bundleBytes` is not checked.

`scripts/package.ts` prints the `assets` array to paste into the manifest.

### E_PERF_BUDGET

A tick cost more than `budgets.microsecondsPerTick` allows. The platform sizes
its isolate CPU cap from this number, so it is a cost statement rather than a
style opinion.

Look for per-tick allocation and full scans first. A simulation that rebuilds
its collision structure every tick is the usual finding.

### E_REPLAY_MISMATCH

A recording was replayed and did not reproduce the state it was recorded from.
This is the one that matters most, because it is the claim the platform makes
to a player about their score.

If `determinism` passes and this fails, the difference is in the recording
rather than in the simulation: an input stamped against the wrong tick, an
`endTick` that does not match where the run stopped, or a config that was
applied at record time and not at replay time.

### E_MANIFEST_SCHEMA

The manifest failed schema validation during the suite, as opposed to at
runtime. Same remedies as `E_MANIFEST_INVALID`.

### E_GLOBALS_TOUCHED

The bundle touched a global the sandbox forbids - `window.top`, `parent`,
`document.cookie`, `XMLHttpRequest`. These are about the embedding, not about
determinism: a game runs in an opaque-origin frame and has no business
reaching out of it.

### E_RENDER_SMOKE

The render bundle failed its smoke check: it threw on a canned state, drew
nothing, or tried to reach a network origin other than the asset CDN.

### E_CHECK_THREW

A check threw while running. That is a failure of the subject, not of the
suite - but it is reported separately so the cause is not misattributed to
whatever the check was about to test. The detail carries the original error.

### E_SUBJECT_LOAD

The subject could not be loaded. Either there is no entry file at the path
given, and the detail lists the names that were looked for, or the file loaded
and had no default export.

A bundle exports its `GameModule`, or a factory that returns one, as its
default export. Check that the build wrote where you pointed the validator, and
that the entry exports the module itself rather than only its parts.
