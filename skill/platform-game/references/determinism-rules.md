# Determinism rules

Simulation code is anything reachable from `init()` or `tick()`. These rules
apply there and nowhere else. The renderer has none of them.

Every rule names the check that enforces it. If a rule here has no check, it
is a preference and is marked as one.

## Why

The platform pays and ranks on results, so a score has to be something it can
verify rather than trust. The browser records inputs, the server replays them,
and both sides must reach the same state - on V8, JavaScriptCore and
SpiderMonkey alike. Every rule below follows from that one sentence.

## Arithmetic

**Allowed**, because ECMAScript specifies them exactly: `+ - * / %`,
comparisons, `Math.sqrt`, `Math.floor`, `Math.ceil`, `Math.round`,
`Math.trunc`, `Math.abs`, `Math.min`, `Math.max`, `Math.sign`, `Math.fround`,
`Math.imul`, `Math.clz32`, and typed-array bit manipulation.

**Banned outright**: `Math.pow` and the `**` operator. Use `dmath.pow`, or
better `dmath.ipow` for an integer exponent, which is exact.

**Banned, use `dmath`**: `sin`, `cos`, `tan`, `asin`, `acos`, `atan`, `atan2`,
`exp`, `log`, `log2`, `log10`, `cbrt`, `hypot`, `sinh`, `cosh`, `tanh`.

These are not theoretical differences. `Math.cos(0.1)` is
`0x3FEFD712F9A817C1` on JavaScriptCore and `0x3FEFD712F9A817C0` on V8. One bit
in one cosine, once, moves a position by a nanometre - and then the hash of
the state differs, and the replay is rejected.

`dmath` is a transcription of netlib's fdlibm, which is what V8 uses for most
of these, so its answers will usually match `Math` on V8 and sometimes not on
another engine. That is fine: what matters is that `dmath` gives the same
answer everywhere, not that it agrees with any particular host.

*Checked by:* `banned-apis` (static scan and runtime shims), `determinism`
across engines.

## Randomness

One `Prng`, seeded from `init(seed)`. Sub-streams by label:

```ts
this.rng = new Prng(seed)
this.spawn = this.rng.stream("spawn")
this.loot = this.rng.stream("loot")
```

Labelled sub-streams are not decoration. With one stream, adding a single draw
to the spawn logic shifts every later loot roll, so a change to one system
silently changes every recorded session. With sub-streams it does not.

`Math.random` is banned. So is seeding from the clock, the URL, or anything
else the server replaying the session will not have.

*Checked by:* `banned-apis`, `determinism`, `replay`.

## Time

There is one clock and it is the tick count. `Date`, `performance.now`,
`setTimeout`, `setInterval` and `requestAnimationFrame` are banned.

Scheduled work uses `Timer`, which counts in ticks and snapshots cleanly:

```ts
this.timer.define("spawn", () => this.spawn())
this.timer.every("spawn", 24)
```

A timer holds names, not functions, because nothing can serialise a closure.
That is why `restore()` calls `init()` first: the handlers have to exist
before the state is imported over them.

*Checked by:* `banned-apis`, `restore`.

## No async

`tick()` may not be `async` and may not return a thenable. Neither may
anything it calls. No `await`, no `.then`, no `queueMicrotask`, no
`structuredClone`.

Anything that needs to wait belongs in the host. Load an asset before the
session starts and pass it as config, or emit an effect and let the host act
on it.

*Checked by:* `no-async`.

## Iteration order

A `Map` and a `Set` iterate in insertion order, which is deterministic if the
insertion history is. That makes them safe and a plain object unsafe: integer
-like keys come first, in ascending numeric order, and everything else follows
in insertion order, so `{ "10": a, "2": b }` iterates `2` then `10`.

Do not sort to paper over an ordering bug. If a sort is load-bearing, its
comparator must be a total order - returning 0 for two items that are not
equal leaves their order up to the engine's sort implementation, and those
differ.

*Checked by:* `determinism` (it is one of the three things that usually causes
a divergence).

## State

`snapshot()` returns plain data: strings, numbers, booleans, `null`, arrays
and object literals. No `NaN`, no `Infinity`, no `undefined`, no functions, no
class instances, no `Map` or `Set` or `Date`.

It has to hold *everything*. The test is not "does it look complete" but
"does restoring at tick N and continuing reach the same state as never having
stopped", which is what check 6 runs at several offsets. The fields people
forget, in order: the PRNG state, the timer state, an id counter, a cooldown,
and the config.

`-0` is kept distinct from `0` in the encoding, deliberately.

*Checked by:* `restore`, and the canonical encoder at runtime.

## Ending

The run must end inside `maxTicks`, under an idle player, under chaos input,
and under the platform's bot. The platform bounds what it pays to replay.

"The player can quit" is not an ending. The idle log is a player who does not.

*Checked by:* `bound`.

## Counters

Counters are declared in the manifest and returned as integers from `score()`.
A counter declared `monotonic` may never move the wrong way, and `isOver()`
may never return false after returning true.

*Checked by:* `counters`.

## What the renderer may do

Everything on this list. `Math.random`, `Math.sin`, `performance.now`, the
DOM, WebGL, audio, the network. Three's `Quaternion` and `Clock`. None of it
is read back by the simulation, so none of it can change a result.

The two rules on that side are: read the view, never write it; and make
`view()` structured-cloneable, because in worker mode it is cloned across a
thread boundary rather than shared.

Interpolate with `alpha`. It is how far this frame sits between the last tick
and the next, and using it is what makes a 60 Hz simulation look right on a
144 Hz display.
