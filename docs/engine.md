# The Clockwork 2 engine

Clockwork 2 runs browser games whose results someone else has to check. The
browser records what the player pressed, a server replays that recording, and
the server's answer is the one that counts. This page explains what the engine
does, why it is built the way it is, and how to write a game on it. It assumes
you know JavaScript and nothing about Clockwork 2.

Contents:

- [The problem](#the-problem)
- [Ticks](#ticks)
- [The loop](#the-loop)
- [Writing a game](#writing-a-game)
- [Randomness](#randomness)
- [Timers](#timers)
- [Arithmetic](#arithmetic)
- [What a simulation may not touch](#what-a-simulation-may-not-touch)
- [State, snapshots and hashing](#state-snapshots-and-hashing)
- [Input](#input)
- [Rendering](#rendering)
- [Sound and other effects](#sound-and-other-effects)
- [Data packs](#data-packs)
- [Recording and replay](#recording-and-replay)
- [The manifest](#the-manifest)
- [Conformance](#conformance)
- [Embedding a game](#embedding-a-game)
- [Writing a game with an agent](#writing-a-game-with-an-agent)
- [Decisions](#decisions)
- [Open questions](#open-questions)

## The problem

Say you run a leaderboard and pay the top score. A browser sends you a number.
You cannot check it. The player controls the machine that produced it, so the
number is a claim, not evidence.

One way out is to stop sending the number and send the inputs instead. The
browser reports which keys were pressed and when; the server runs the same game
over the same inputs and computes the score itself. Now the player controls the
inputs, which is exactly what they are supposed to control, and the server
controls the result.

This only works if the game is a pure function. Same seed, same configuration,
same inputs, same final state, on the player's phone and on your server, in
every JavaScript engine either might be running. Miss that in one place and the
replay reaches a different state, so a legitimate score is rejected or, worse,
you never notice and both answers stay plausible.

Most of this engine is the work of making that property hold and of making it
testable. Three things break it in practice:

- Time. If the simulation reads the clock, the result depends on how fast the
  machine ran.
- Randomness. If the simulation calls `Math.random`, nobody can reproduce it.
- Arithmetic. `Math.sin` and friends are allowed to give different answers in
  different engines, and they do.

Each has a section below.

## Ticks

A tick is one step of the simulation. Everything in the game advances in whole
ticks, and a tick is the same size everywhere: it has no duration in the
simulation's own terms, it is just the next step.

A game declares its rate in its manifest, in ticks per second: 30, 60 or 120.
The number says how fast the world moves. How many frames get drawn while it
moves is the display's business.

The function that advances a tick takes no time argument at all:

```ts
tick(inputs: readonly InputEvent[]): void
```

A simulation with no delta to integrate against cannot depend on the frame
rate, because nothing ever told it what the frame rate was.

## The loop

Real frames arrive unevenly. `requestAnimationFrame` fires roughly every 16.7 ms
on a 60 Hz display, 6.9 ms on a 144 Hz one, and not at all while the tab is in
the background. The host absorbs that unevenness by keeping an accumulator of
elapsed time and spending it in whole ticks:

```js
const STEP_MS = 1000 / tickHz
let accumulator = 0
let last = performance.now()
let tick = 0

function frame(now) {
  accumulator += Math.min(now - last, MAX_FRAME_MS)
  last = now

  let steps = 0
  while (accumulator >= STEP_MS && steps < MAX_CATCHUP_TICKS) {
    game.tick(inputsAt(tick))
    tick++
    accumulator -= STEP_MS
    steps++
  }
  if (steps === MAX_CATCHUP_TICKS) accumulator = 0

  presentation.render(game.view(), previousView, accumulator / STEP_MS, elapsed)
  requestAnimationFrame(frame)
}
```

Jitter changes how many ticks a frame runs. It never changes how big one is. A
frame can run zero ticks, one, or several, and after any whole second the same
number of ticks has run on a 60 Hz display and a 144 Hz one.

Worked example, at a 16.667 ms step:

| frame | elapsed | accumulator before | ticks run | left over |
| --- | --- | --- | --- | --- |
| 1 | 16.4 | 16.40 | 0 | 16.40 |
| 2 | 17.1 | 33.50 | 2 | 0.17 |
| 3 | 16.9 | 17.07 | 1 | 0.40 |
| 4 | 33.2 (dropped frame) | 33.60 | 2 | 0.27 |

Two guards keep a stalled tab from turning into a burst of simulation.
`MAX_FRAME_MS` (250 ms) clamps what a single frame may contribute, and
`MAX_CATCHUP_TICKS` (5) caps how many ticks one frame may run. When the cap is
hit the leftover debt is dropped rather than carried, so a tab that was hidden
for four minutes resumes where it left off instead of fast-forwarding through
four minutes of play. Both are exported, as `DEFAULT_MAX_FRAME_MS` and
`DEFAULT_MAX_CATCHUP_TICKS`, so tests assert against them instead of
hardcoding the numbers.

Dropping debt has a consequence worth stating: the session ends at the tick the
host actually reached, and the recording says so. Replay runs exactly that many
ticks.

The leftover fraction, `accumulator / STEP_MS`, is handed to the renderer as
`alpha`. It says how far the current frame sits between the last tick and the
next, which is what lets a 60 Hz simulation look smooth on a 144 Hz display.
Nothing reads it back, so it cannot reach the result.

A server has no frames and no renderer. It runs the same simulation from a
plain loop:

```ts
for (let t = 0; t < recording.endTick; t++) game.tick(inputsAt(t))
```

Both sides call the same `runSession()` in `@clockwork2/engine`. Replay is not
a second code path; it is the ordinary loop reading inputs from a recording
instead of from a keyboard.

## Writing a game

A game is a module with eight methods, and a ninth for a game that reads data
packs. Nothing else is required, and nothing about the shape of your state is
prescribed.

```ts
interface GameModule<TView, TConfig> {
  readonly manifest: unknown

  init(seed: string, config: TConfig, packs: PackReader): void
  tick(inputs: readonly InputEvent[]): void
  view(): TView
  snapshot(): Snapshot
  restore(snapshot: Snapshot): void
  score(): Counters
  isOver(): boolean
  effects(): readonly Effect[]
  packsNeeded?(): readonly string[]
}
```

`init` sets up a session from a seed and a configuration. It does no I/O, reads
no clock, and fetches nothing. Small settings arrive in `config`, which is in
the recording, so the server replaying it has the same copy. Data the game
reads, such as a level or a table of stats, ships as a data pack, and `init`
receives the reader for it as `packs`; see [Data packs](#data-packs). A game
with no packs can leave the third parameter off.

`tick` advances one step. It is the only thing that writes simulation state.

`view` returns what the renderer draws. It may return a live reference to
internal state when the renderer shares a thread, so renderers treat it as
read-only. It must be structured-cloneable, because in worker mode it is cloned
across a thread boundary.

`snapshot` returns a plain-data copy of everything the simulation knows, and
`restore` puts one back. Between them they give save, resume, partial replay,
and a way to prove that a snapshot is complete. See
[State, snapshots and hashing](#state-snapshots-and-hashing).

`score` returns the counters the manifest declares, as integers. `isOver`
returns true once the session has ended and never returns false afterwards.

`effects` returns cues from the last tick, such as a sound to play, and the
host drains them. See [Sound and other effects](#sound-and-other-effects).

`packsNeeded` names the demand packs the next tick will read. Leave it out
when there are none.

Here is a whole small game. Three lanes, rocks coming towards the player, one
mote to collect; move sideways, survive.

```ts
import {
  dmath, Prng, Timer,
  type Counters, type Effect, type GameModule,
  type InputEvent, type PrngState, type Snapshot, type TimerState,
} from "@clockwork2/engine"

const LANES = 3
const TRACK = 100

export class LaneRunner implements GameModule<View, Config> {
  readonly manifest = MANIFEST
  private rng!: Prng
  private spawn!: Prng
  private timer = new Timer()
  private lane = 1
  private rocks: Rock[] = []
  private ticks = 0
  private over = false
  private pending: Effect[] = []

  init(seed: string, config: Config): void {
    this.rng = new Prng(seed)
    this.spawn = this.rng.stream("spawn")
    this.timer = new Timer()
    this.timer.define("spawn", () => {
      const lane = this.spawn.randomInt(0, LANES - 1)
      this.rocks.push({ id: this.nextId++, lane, z: TRACK })
      this.timer.after("spawn", this.spawnInterval())
    })
    this.timer.after("spawn", 24)
    this.lane = config.startingLane
    this.rocks = []
    this.ticks = 0
    this.over = false
    this.pending = []
  }

  tick(inputs: readonly InputEvent[]): void {
    if (this.over) return
    for (const input of inputs) {
      if (input.value <= 0) continue
      if (input.code === "left" && this.lane > 0) this.lane--
      if (input.code === "right" && this.lane < LANES - 1) this.lane++
    }
    for (const rock of this.rocks) rock.z -= 1
    for (const rock of this.rocks) {
      if (rock.z <= 0 && rock.z > -1 && rock.lane === this.lane) {
        this.over = true
        this.pending.push({ type: "sound", data: "hit" })
      }
    }
    this.rocks = this.rocks.filter((rock) => rock.z > -1)
    this.timer.advance()
    this.ticks++
  }

  view(): View {
    return {
      lane: this.lane,
      rocks: this.rocks.map((rock) => ({ ...rock })),
      over: this.over,
      sway: dmath.sin(this.ticks / 30),
    }
  }

  snapshot(): Snapshot {
    return {
      lane: this.lane,
      rocks: this.rocks.map((rock) => ({ ...rock })),
      ticks: this.ticks,
      over: this.over,
      rng: this.rng.exportState() as unknown as Snapshot,
      timer: this.timer.exportState() as unknown as Snapshot,
    }
  }

  restore(snapshot: Snapshot): void {
    const s = snapshot as unknown as Saved
    this.init("restored", s.config)
    this.lane = s.lane
    this.rocks = s.rocks.map((rock) => ({ ...rock }))
    this.ticks = s.ticks
    this.over = s.over
    this.rng.importState(s.rng)
    this.timer.importState(s.timer)
    this.pending = []
  }

  score(): Counters {
    return { ticksSurvived: this.ticks }
  }

  isOver(): boolean {
    return this.over
  }

  effects(): readonly Effect[] {
    const drained = this.pending
    this.pending = []
    return drained
  }
}

export default function createGame(): LaneRunner {
  return new LaneRunner()
}
```

Two details in that code are load-bearing and easy to miss.

`restore` calls `init` first. A restored timer holds handler names, not
functions, because nothing can serialise a closure, so the handlers have to
exist before the state is imported over them. A game that reads packs keeps
the reader `init` received and hands it back here, as
`this.init("restored", s.config, this.packs)`, or the second `init` replaces
it with nothing.

The game takes its randomness from `this.spawn`, a labelled sub-stream, rather
than from the root generator.
[Randomness](#randomness) explains why that matters.

### Ending

Every session has to end inside the `maxTicks` its manifest declares, with an
idle player, with random input, and with a competent one. A platform bounds
what it pays to replay, so a game that can run forever cannot be accepted.

"The player can quit" is not an ending. An idle player never quits, and the
conformance suite plays an idle log to check.

Usually the ending is a difficulty ramp that eventually beats anyone, a time
limit, or a life count. The example above shrinks its spawn interval as the
run goes on.

## Randomness

A simulation may not call `Math.random`. Randomness comes from `Prng`, seeded
from the seed passed to `init`:

```ts
this.rng = new Prng(seed)
this.rng.randomInt(1, 6)
this.rng.randomFloat(0, 1)
this.rng.randomChoice(["a", "b", "c"])
this.rng.shuffle(deck)
```

The generator is alea, vendored into the kernel so the kernel has no runtime
dependencies. Its step is `t = 2091639 * s0 + c * 2.3283064365386963e-10`, which
uses only multiplication, addition and a truncation, all exactly specified by
ECMAScript. The stream is therefore identical in every engine. The vendored copy
is checked against `alea@1.0.1` by a test that compares 10,000 draws.

There is no unseeded constructor. Upstream alea seeds from the clock when called
with no argument, which produces a stream nobody can reproduce, so `new Prng()`
throws `E_SEED_REQUIRED`.

### Sub-streams

Draw everything from one generator and the systems become coupled: add a single
draw to the spawn logic and every later loot roll shifts, which silently changes
every session anyone already recorded.

Labelled sub-streams remove that coupling.

```ts
this.spawn = this.rng.stream("spawn")
this.loot = this.rng.stream("loot")
```

Each is seeded from its parent's seed and its label. Drawing from one never
moves the other, and a sub-stream created for the first time after a restore is
still the same stream it would have been. The generator's whole tree goes into
the snapshot with `exportState()` and comes back with `importState()`, root seed
included.

## Timers

A simulation may not call `setTimeout` or `setInterval`. The kernel's `Timer`
counts in ticks:

```ts
this.timer.define("spawn", () => this.spawn())   // in init, before scheduling
this.timer.after("spawn", 24)                    // once, 24 ticks from now
this.timer.every("spawn", 24)                    // every 24 ticks
this.timer.advance()                             // once per tick
```

Timers are scheduled against absolute target ticks. Two timers due on the same
tick run in the order they were created, which makes the order part of the
recorded behaviour rather than a property of the runtime. A delay of zero means
the next tick, never the current one, because a handler that can schedule work
into the pass it is running in can loop forever.

`every` adds a schedule each time it is called. To change an interval, use a
one-shot that re-arms itself, as the example game does. Calling `every` again
from inside its own handler leaves the old schedule running beside the new one.

The state exports as plain data and holds handler names, not functions.

## Arithmetic

ECMAScript specifies `+ - * / %`, comparisons, `Math.sqrt`, `Math.floor`,
`Math.ceil`, `Math.round`, `Math.trunc`, `Math.abs`, `Math.min`, `Math.max`,
`Math.sign`, `Math.fround`, `Math.imul` and `Math.clz32` exactly. Every engine
must produce the same bits, and they do.

It leaves `sin`, `cos`, `tan`, `asin`, `acos`, `atan`, `atan2`, `exp`, `log`,
`log2`, `log10`, `cbrt`, `hypot`, `pow` and the hyperbolics implementation
defined. Engines take different approaches, and the differences are easy to
measure. Twenty thousand seeded inputs per function, the same bytes run under
Bun (JavaScriptCore) and Node (V8), comparing the exact bit pattern of each
result:

| function | inputs that differ |
| --- | --- |
| `Math.hypot` | 35.7% |
| `Math.pow` | 9.8% |
| `Math.exp` | 9.5% |
| `Math.acos` | 7.7% |
| `Math.asin` | 5.8% |
| `Math.tan` | 3.6% |
| `Math.sin` | 3.4% |
| `Math.cos` | 3.3% |
| `Math.log` | 0.2% |
| `Math.atan` | 0.0% |
| `Math.sqrt` | 0.0% |

`Math.cos(0.1)` is `0x3FEFD712F9A817C1` on JavaScriptCore and
`0x3FEFD712F9A817C0` on V8. One bit, in one cosine, once. Then the state hash
differs, and the replay is rejected.

So the kernel ships `dmath`, with the same function names:

```ts
import { dmath } from "@clockwork2/engine"

dmath.sin(x)
dmath.atan2(y, x)
dmath.pow(base, exponent)
dmath.ipow(base, 3)      // integer exponent, exact
dmath.wrapAngle(angle)
```

Each function is a transcription of the netlib fdlibm routine of the same name,
including the Payne-Hanek argument reduction that keeps `sin` correct for a
large accumulated angle. They are written from exactly specified operations
only, so they give the same bits everywhere. Golden vectors pin them, and the
vectors are compared across engines on every CI run.

`Math.pow` and the `**` operator are banned outright rather than replaced
quietly, because an exponent that happens to be an integer has an exact answer
and `dmath.ipow` gives it.

A note on accuracy: `dmath` matches V8 bit for bit on 450,000 seeded samples
across `sin`, `cos`, `tan`, `asin`, `acos`, `atan`, `atan2`, `exp` and `log`,
because V8's own implementations come from the same fdlibm. Where fdlibm and a
host library disagree, the difference is recorded as data with a test asserting
it is still exactly what it says. Agreeing with any particular host is not the
goal; agreeing with itself everywhere is.

### How close "the same" is

Two claims get mixed up here, so they are worth separating.

`dmath` promises that every engine computes the same bits from the same input.
That is the property a replay needs, and the golden vectors and the cross-engine
sweep are what check it.

It does not promise those bits are the true value of the function, and no binary
floating-point library can, because `sin(0.1)` has no exact double. Accuracy is
measured in ulp, the unit in the last place: the gap between one representable
double and the next. Near 1.0 that gap is about 1.1e-16, so a result 2 ulp from
the truth is wrong somewhere around the sixteenth significant digit. fdlibm aims
for under 1 ulp and usually reaches it.

If a `dmath` function were 2 ulp out everywhere, every engine would still agree
and every replay would still settle. Accuracy is a separate quality from
reproducibility, and this engine is built for the second. That is also why the
tests comparing `dmath` against the host's own `Math` carry loose bounds: where
the two disagree by a rounding step it is as likely the host that is loose. On
macOS arm64, `Math.tan(351.07445158064365)` is 2.52 ulp from the true value and
`dmath.tan` is 0.48 ulp from it, which is the nearest double there is.

### The one freedom hardware keeps: the sign of a NaN

Everything above is about the engine. The processor underneath it has one
remaining latitude, and it is worth knowing before it surprises you.

ECMAScript leaves a NaN's sign and payload implementation-defined, and
processors differ. An invalid operation produces the negative quiet NaN
`0xFFF8000000000000` on x86 and the positive `0x7FF8000000000000` on arm64:

```ts
import { toBitsHex } from "@clockwork2/engine"

// `inf` has to be read from a variable. A literal `Infinity - Infinity` is
// folded at parse time and gives the positive NaN on both architectures.
toBitsHex(inf - inf)        // FFF8000000000000 on x86, 7FF8000000000000 on arm64
toBitsHex(Number.NaN)       // 7FF8000000000000 on both: the literal is not computed
```

Of the 1212 NaN-producing golden vectors, 1074 differ between an Apple Silicon
Mac and an x86 Linux runner. The other 138 propagate a NaN that arrived as an
argument, and a propagated NaN keeps the sign it came with.

`bun run test:engines` cannot see any of this, because it runs all five engines
on one machine. So the golden comparison asserts that a NaN result is a NaN, and
never which NaN it is.

That is safe because a NaN cannot reach anything that decides a score. The three
reasons are properties to preserve rather than luck:

- `hashCanonical` refuses a NaN with `E_CANONICAL_UNSUPPORTED`, so one can never
  enter a snapshot or a checkpoint hash.
- A counter must be a whole number, so one can never be a score.
- A recording is JSON, and `JSON.stringify(NaN)` is `null`.

One route around all three used to be open, which is why this section exists.
`dmath.copysign` reads the sign bit of its second argument and returns a finite
number, so a NaN could hand its architecture-dependent sign to a value the hash
would take: `copysign(5, inf - inf)` was `-5` on x86 and `5` on arm64. Both are
finite, both hash, and two players diverge from there on the same inputs.

So `copysign` refuses a NaN in either argument with `E_ARG_INVALID`, which
fdlibm's C does not:

```ts
dmath.copysign(5, -1)          // -5
dmath.copysign(5, inf - inf)   // throws E_ARG_INVALID
```

Reaching that error means the simulation already produced a NaN, which is a bug
the kernel would have reported at the next hash anyway. The throw just moves the
report to the line that caused it. Anything added to `dmath` later that reads a
sign bit or a payload rather than a value needs the same treatment.

## What a simulation may not touch

Simulation code is anything reachable from `init` or `tick`. In that code these
are unavailable:

`Math.random`, `Date`, `performance.now`, `setTimeout`, `setInterval`,
`requestAnimationFrame`, `crypto`, `Intl`, `toLocaleString`, `localeCompare`,
`WeakRef`, `FinalizationRegistry`, `structuredClone`, `queueMicrotask`,
`Atomics`, and `WebAssembly` outside an allow-list.

Two mechanisms enforce this, because each misses what the other catches.

The kernel installs runtime traps around `init` and `tick` and removes them
afterwards. Touching a banned global throws `E_BANNED_API` at the point of use,
so the stack points at the line.

`@clockwork2/engine/validate` scans the simulation's entry file and every module it
imports, transitively, and reports `E_LINT_BANNED` with a file, line and
column. A scan sees code that never runs; the traps see an aliased global, a
dynamic import, and anything the scan cannot follow.

There is no asynchronous escape hatch. `tick` may not be `async` and may not
return a thenable; the kernel throws `E_ASYNC_TICK` if it does. Work that has
to wait belongs in the host. Data the simulation reads is a data pack, which
the host fetches and the kernel hands over at a step the game names. Anything
else is an effect the host acts on.

Iteration order is part of the contract. `Map` and `Set` iterate in insertion
order, which is deterministic when the insertion history is. A plain object is
not safe for ordered iteration: integer-like keys come first in ascending
numeric order whatever the insertion history, so `{ "10": a, "2": b }` iterates
`2` before `10`.

## State, snapshots and hashing

`snapshot()` returns plain data: strings, numbers, booleans, `null`, arrays and
object literals. No `NaN`, no `Infinity`, no `undefined`, no functions, no class
instances, no `Map`, `Set` or `Date`. The canonical encoder refuses anything
else with `E_CANONICAL_UNSUPPORTED` and names the path that held it.

The encoder sorts keys, writes integers as 64-bit values, writes other numbers
by their IEEE bit pattern, and keeps negative zero distinct from zero. Two
states that differ only in key order encode identically; two that differ in any
value do not.

That encoding is hashed into a 64-bit digest computed in two 32-bit lanes with
`Math.imul` and `>>>`, both exactly specified, which makes the digest identical
in every engine and cheap enough to take once a second inside the loop.

The real test of a snapshot is not whether it looks complete. It is this: take
a snapshot at tick N, restore it into a freshly evaluated module, continue, and
compare against a run that was never interrupted. They have to match. The
conformance suite runs that at several offsets, and the fields people leave out
are, in order: the generator state, the timer state, an id counter, a cooldown,
and the configuration.

## Input

A game declares its inputs in its manifest, each a name and the whole numbers it
carries, and records what its player did as those inputs:

```ts
inputs: {
  left: { min: 0, max: 1, label: "Left" },   // a press: 1 down, 0 up
  aimX: { min: 0, max: 31 },                  // a position, in 32 steps
  steer: { min: -10, max: 10 },               // a stick or a tilt
}
```

A recorded input is three fields:

```ts
type InputEvent = {
  readonly tick: number   // the tick the simulation is about to run
  readonly code: string   // the name of a declared input
  readonly value: number  // a whole number in its declared range
}
```

There is no device. Whether `left` came from a key, a finger or a stick is the
game's page's business, and the game decides what to record. `tick` reads the
inputs and decides what they mean.

The tick is stamped when the input enters the queue, against the tick that is
about to run. That is the only timing information a recording carries, and it
is what makes replay exact.

The live queue checks every input where it is pushed: a name the manifest does
not declare, or a value outside its range, throws `E_INPUT_UNDECLARED`, so a
misspelt name in a page is found while its author plays. A server holds a
submitted log to the same rules with `checkInputs`, against the manifest it
stored for the version, and to a budget of `INPUT_BUDGET_PER_TICK` inputs per
tick on average (`E_INPUT_BUDGET`). A browser following the manifest never
records anything else, but the code in a game's page is the game's own, and a
log reaches a server from anywhere; the replay and `checkInputs` are what a
score rests on.

One thing to decide in `tick` rather than in the page: what a tap hit. A game
that worked out in its drawing code that a tap landed on a target and recorded
only the answer would replay perfectly and still have decided the result where
nothing checks it. Record where the finger was, and hit-test in `tick`.

### Choosing what to record

Every value an input passes through is an input to record, store and replay, so
what a game declares and how it records decides how big its recordings are.
The rules:

- **Declare the coarsest range the game needs.** A pointer measured in 32 steps
  across the screen records a fraction of what one measured in 1000 does,
  because a finger moving slowly crosses far fewer steps. The range is the
  recording's resolution.
- **Record what changed, not a stream.** A level (a position, a stick, tilt) is
  worth recording when its value changes; an unchanged reading is not an input.
- **Keep one value per tick.** Several readings of a stick between two ticks
  are one input: where it ended up.
- **Prefer a game-sized value to a raw reading.** A steer from -10 to 10
  derived from tilt records less, and replays the same, as three gravity axes
  from -100 to 100.
- **Leave out what the game does not read.** A hover position, a third tilt
  axis or a second stick costs inputs whether or not `tick` looks at it.

The device helpers below do the first four for every input they record. The
guide's `references/inputs.md` has the measured size of a five-minute
recording from each helper, at a coarse and a fine range, and says how each
was produced: the busiest, two thumbs on a pointer declared 0 to 1000, records
3.9 inputs a tick and 3.0 MB of JSON.

### The device helpers

`InputCapture` in `@clockwork2/engine/host` is one way to record the common
devices, and a game may use it, use part of it, or record its inputs itself by
pushing to `host.live`. It takes a mapping in the game's code:

```ts
new InputCapture({
  manifest: MANIFEST,
  queue: live,                           // host.live, null only in a replay
  element: canvas,                       // pointers and the wheel are heard here
  keys: { ArrowLeft: "left", KeyA: "left" },
  pointers: [{ down: "tap", x: "aimX", y: "aimY" }, { down: "tap" }],
  wheel: { y: "zoom" },
  gamepads: { any: { buttons: { 0: "jump" }, axes: { 0: "steer" } } },
  tilt: { x: "steer", fullAt: 30 },
  onNotice: (notice) => showTo(player, notice),
}).attach()
```

`checkCapture(mapping, manifest)` checks a mapping without attaching it: every
name declared, a press's range holding 0 and 1, one source for a position or an
amount, key names that exist. The constructor runs it and throws, and a page
can run it before it starts a run, so a mistake never spends one.

What each kind of input records:

- **A press** (a key, a pointer going down, a mouse or gamepad button) is 1
  while held and 0 when released. A name pressed from several places is down
  while any of them is. An auto-repeat is not an input.
- **A position or a reading** (a pointer's x or y across the element, a stick
  axis, a trigger, tilt) is recorded in its name's range when it changes, and
  merged to the last value of each tick. A stick rests at the middle of its
  range and a trigger at its minimum, and reading them there is not an input.
  Sticks and tilt have a deadband.
- **An amount** (wheel notches, mouse movement while the mouse is locked to the
  game) is summed per tick, its fraction carried, and held to its range; what a
  tick could not carry is carried into later ticks, up to one range.

Every press the helpers record they also release. A pointer is captured when it
goes down, so a mouse released outside the element still comes up; a capture
lost after the release takes no slot; a finger the browser takes away for a
scroll is released; and window blur, a hidden tab, a pause and an unplugged
controller each release everything held. `touch-action: none` is set on the
element, so a drag on a drawn control stays a drag.

Pointers have small slot numbers: slot 0 is the first finger down, slot 1 the
second. A slot is taken only when a pointer goes down, so a mouse resting over
the game does not push a finger to slot 1. A second mouse button pressed while
one is held arrives as a move with new `buttons`, and the helpers record it
from there; mapping a right button also keeps the browser's menu shut.

A blocked gamepad, a controller without the standard layout and a refused
mouse lock are reported to `onNotice` and never stop the run: a player on keys
or touch plays on.

Tilt is read from `deviceorientation` as the direction of gravity across the
screen, x to the right, y up and z out of the screen, turned with the screen,
and mapped onto each name's range. iOS asks the player's permission only from a
tap, so a page calls `requestMotion()` as the first thing its Play button's
click does, before anything is awaited, and starts the run after the answer. It
resolves granted once a first real reading arrives, or a refusal naming why:
`E_MOTION_INSECURE` (not https), `E_MOTION_UNSUPPORTED`, `E_MOTION_DENIED`,
`E_MOTION_BLOCKED` (the page's permissions policy) or `E_MOTION_NO_SENSOR`.

## Rendering

A presentation implements three methods:

```ts
interface Presentation<TView, TContainer> {
  mount(container: TContainer, context: PresentationContext): void
  render(view: TView, previousView: TView | null, alpha: number, dtMs: number): void
  unmount(): void
}
```

It reads and never writes, neither the view nor anything the simulation reads
back. That one restriction is what makes everything else permitted: a renderer
may use `Math.random` for a visual flourish, `performance.now`, WebGL, audio,
the network, and Three's `Quaternion` and `Clock`, because none of it can reach
a result.

`alpha` is how far this frame sits between the last tick and the next, in
`[0, 1)`. Interpolating positions with it is what makes the game look right on a
display whose rate is not a multiple of the tick rate. Ignoring it makes a 60 Hz
simulation judder on a 144 Hz screen.

`dtMs` is real milliseconds since the previous frame, which is legitimate here
precisely because nothing reads it back.

Three adapters ship, each read-only and driven the same way:

| Package | Renderer |
| --- | --- |
| `@clockwork2/engine/adapter-canvas2d` | 2D canvas |
| `@clockwork2/engine/adapter-three` | Three.js |
| `@clockwork2/engine/adapter-pixi` | PIXI 8 |

Each owns its surface, its device-pixel scaling and its draw call, and takes one
`draw` function from the game. None of them starts its renderer's own animation
loop: the host decides when a frame happens.

Every renderer faces the same problem, that the view is a list and the scene is
a set of objects, so the kernel provides `NodeSet` and all three adapters
re-export it:

```ts
const rocks = new NodeSet<Rock, Mesh>({
  id: (rock) => String(rock.id),
  create: () => new Mesh(geometry, material),
  update: (node, rock) => node.position.set(x(rock), 0, rock.z),
  destroy: (node) => scene.remove(node),
})
rocks.sync(view.rocks)
```

## Sound and other effects

Sounds, rumbles and camera shakes come out of `effects()` as plain data and the
host drains them each frame:

```ts
this.pending.push({ type: "sound", data: "hit" })
```

They are values rather than calls inside `tick` for two reasons. A headless
replay has nothing to stub, and a frame that runs two ticks cannot play the same
sound twice by accident.

`AudioSink` in `@clockwork2/engine/host` turns effects into sound, including
procedurally generated sound, so a game can ship without audio files. The demo
in this repository synthesises all of its audio that way.

## Data packs

A game's rules often live in data: a level layout, a table of vehicle stats,
the map of a town. Putting that data in `config` would put it in every
recording, and building it into the bundle makes every version of the game
ship every level at once. A data pack is a file the manifest declares with
`requiredForSim: true`. The host fetches it, the kernel checks it and hands it
to the simulation, and the server replays the run with the same bytes.

```ts
assets: [
  { path: "packs/rules.json", sha256: "...", bytes: 512,
    requiredForSim: true, license: "CC0" },
  { path: "packs/harbor.json", sha256: "...", bytes: 90210,
    requiredForSim: true, load: "demand", license: "CC0" },
]
```

The manifest hash every recording carries covers these entries, so a
recording pins the bytes of every pack its run could have read without a field
of its own.

### Start and demand

A start pack, the default, must be in hand before the session is built,
because `init` runs inside the `Session` constructor and may read it. `init`,
`restore` and every tick can read a start pack.

A demand pack, `load: "demand"`, arrives during play, and the game says when it
needs one:

```ts
packsNeeded(): readonly string[] {
  return this.inHarbor() ? ["packs/harbor.json"] : []
}
```

The kernel calls `packsNeeded` once after `init`, once after `restore` and
once after every tick, in every host, and the answer decides what the next tick
may read. A host that lacks a pack the game named holds its loop: it runs no
tick, feeds no time to the accumulator, and carries on from the same tick when
the bytes arrive. The step at which a game first reads a pack is therefore a
function of the game's state alone. A pack that took five seconds to download
and one that was already cached are read at the same tick, and so is the one a
server replay had from the start.

Nothing tells a game whether a pack has arrived, and that is the rule the rest
depends on. A game that could ask could take a different branch on a fast
connection, and the replay would take the other one.

### Where a game may read

| Where | Start packs | Demand packs |
| --- | --- | --- |
| `init` | yes | no |
| `restore` | yes | no |
| a tick | yes | the ones `packsNeeded` named before it |
| anywhere else | no | no |

"Anywhere else" means `view`, `snapshot`, `score`, `isOver` and
`packsNeeded` itself, and the reason is that hosts call them at different
times: a page calls `view` before every step, a worker after its steps, and a
server replay never. A read there is `E_PACK_NOT_REQUESTED`. What the
renderer needs from a pack goes into the state `view` returns.

The set of readable demand packs is recomputed from scratch before each tick
rather than added to, so it depends on the current state and not on the
history. That is what lets a snapshot restore exactly: a snapshot holds pack
names and positions, never pack contents, and after a restore the game opens a
pack again on the first tick that needs it, where `packsNeeded` names it from
the restored state.

### Reading

`packs.open(path)` returns the bytes as a new `Uint8Array` on every call. A
server replaying many runs of one version holds one copy of each pack and lets
every session read it, and a game that could write into that copy would hand
the next replay different bytes.

`packs.json(path)` decodes the bytes as UTF-8 and parses them as JSON, afresh
on every call. The engine decodes with its own strict decoder because
`TextDecoder` is a WHATWG API rather than an ECMAScript one. Two more limits
keep engines agreeing. ECMAScript fixes the value of a number with at most 20
significant digits and lets each engine pick between two neighbours above that,
so `json` refuses a longer one. V8's longest string is 536,870,888 code units
where JavaScriptCore and SpiderMonkey allow more, so `json` refuses a pack
larger than that. Each refusal is `E_ARG_INVALID`, naming the pack.

Open a pack once and keep what you parsed, outside the snapshot. Opening a
large pack every tick copies it every tick.

### Hints

A game emits `{ type: "prefetch", data: "packs/harbor.json" }` from `effects()`
when it will need a pack soon, and the host starts the download, so the pack is
usually there before the loop would hold. `data` may be an array of paths.
Effects never reach state, so a hint that is late or lost changes how long the
loop waits and nothing else. The kernel checks every name a hint carries, and
an undeclared one fails the run at the same tick in every host.

### Checking the bytes

The kernel checks a pack before a session may read it: its length against
`bytes` first, so an oversized file is refused with `E_PACK_TOO_LARGE` before
anything is hashed, then its SHA-256 against `sha256`, refused with
`E_PACK_HASH_MISMATCH`. It hashes and keeps its own copy, so a caller that
reuses or transfers its buffer afterwards cannot change what the simulation
reads.

The SHA-256 is the kernel's own, written from FIPS 180-4 in exactly specified
32-bit arithmetic, because Web Crypto is asynchronous and trapped inside the
simulation. It hashed a 32 MiB pack in 234 ms under Bun and in 299 ms under
node 22 on the machine it was written on. `PackSet.verify` checks a set of
packs once so that any number of sessions can share it: the conformance suite
runs about seventy sessions of a game on one set, and a server can keep one
per game version.

### Memory

A demand pack a host delivered is dropped once the game has named it and then
stops naming it, so a run through ten towns does not end holding all ten. If
the game names it again, the host fetches it again and the loop holds as it
did the first time. A pack that was prefetched and not yet named is kept, and
nothing in a shared `PackSet` is ever dropped.

### What can go wrong

Five codes, each with a section in the skill's
[failure-modes reference](../skill/platform-game/references/failure-modes.md):
`E_PACK_UNDECLARED` for a name the manifest does not declare as a pack,
`E_PACK_NOT_REQUESTED` for a read the table above does not allow,
`E_PACK_NOT_DELIVERED` for a pack a session needed and never got,
`E_PACK_HASH_MISMATCH` for the wrong bytes, and `E_PACK_TOO_LARGE` for too many
of them. The first two are the game's to fix. `E_PACK_NOT_DELIVERED` is the
host's or the platform's, which is why it has a code of its own: a platform can
retry it.

## Recording and replay

A recording is what the browser sends and the server verifies:

```jsonc
{
  "format": "cw2-recording",
  "version": 2,
  "kernelVersion": "0.1.0",
  "gameId": "lane-runner",
  "gameVersion": "1.0.0",
  "manifestHash": "e4d755ee070bbde2",
  "tickHz": 60,
  "seed": "...",
  "config": { "speed": 1 },
  "inputs": [{ "tick": 12, "code": "left", "value": 1 }],
  "checkpoints": [{ "tick": 0, "hash": "..." }, { "tick": 60, "hash": "..." }],
  "endTick": 1650,
  "terminal": "completed",
  "counters": { "ticksSurvived": 1650 },
  "hostStats": { "frames": 1650, "ticksRun": 1650, "mostTicksInAFrame": 2, "droppedMs": 0 }
}
```

Replay is determined by the seed, the config, the inputs, `endTick` and the
data packs the manifest pins. Nothing else is needed to reproduce the run.

`hostStats` is the exception that proves it: a replay ignores the field
entirely. It is what the host's own loop measured while the run was happening,
and it is in the envelope because a platform reading a submission cannot
otherwise tell a player who is cheating from a player on a slow phone, and
those need different answers. `droppedMs` is not an integer - the accumulator
drops a fraction of a millisecond at a time and this is their sum, so a stalled
tab reports something like `299916.6666666667`. Time the loop spent holding
for a data pack is counted there too, because it is also real time that
produced no ticks.

It is `null` on a version 1 recording, which is the only reason it is nullable
rather than absent: `Recording` has to remain a `PlainValue`, and an optional
property does not satisfy that index signature.

Checkpoints are a state hash taken once a second. A replay does not read them;
it produces its own and compares. Their only job is to turn "this recording does
not replay" into "this recording stopped matching at tick 1380", which is the
difference between a bug report and a debugging session.

There is no per-frame delta array. Timing lives in the input ticks and nowhere
else.

`decodeRecording` checks `format` and `version` and throws
`E_RECORDING_VERSION` for anything it does not read, rather than guessing. A
recording is evidence, and a codec that silently reinterprets old evidence
produces confident wrong answers.

What it does read is every version in `READABLE_RECORDING_VERSIONS`, currently
1 and 2. Refusing an older recording because the kernel has moved on throws the
evidence away rather than protecting anything, so a version is dropped from
that list only when a field's meaning changed rather than when one was added.

To replay one:

```ts
import { decodeRecording, RecordedInputSource, runSession } from "@clockwork2/engine"

const recording = decodeRecording(text)
const result = runSession({
  module: createGame(),
  seed: recording.seed,
  config: recording.config,
  inputs: new RecordedInputSource(recording.inputs),
  maxTicks: recording.endTick,
  checkpointEvery: recording.tickHz,
  counters: MANIFEST.counters,
  assets: MANIFEST.assets ?? [],
  packs: PackSet.verify(MANIFEST.assets, packBytes),
})
```

`packBytes` maps each pack's path to its bytes. A replay that leaves out a
pack the run read stops with `E_PACK_NOT_DELIVERED` at the tick that needed it.

`compareToRecording` then reports whether the checkpoints, the end tick and the
counters agree, and where the first disagreement was.

This repository proves the round trip end to end: a session played in Chromium
with real key events is written to disk, replayed under Bun and under Node, and
all three agree line for line.

## The manifest

The manifest is a JSON-shaped value the platform reads without running the game.
That is its purpose: a platform deciding whether to run untrusted code should
not have to run it first.

```ts
{
  schemaVersion: 2,
  id: "lane-runner",            // immutable across every version
  version: "1.0.0",             // semantic; a patch keeps the rules
  name: "Lane Runner",
  kernel: { version: "0.1.0" },

  session: {
    tickHz: 60,                 // 30, 60 or 120
    maxTicks: 7200,             // hard cap; the kernel ends the run here
    maxWallSeconds: 300,
    hasEnding: true,
  },

  inputs: {                     // what the game records, by name and range
    left: { min: 0, max: 1, label: "Left" },
    right: { min: 0, max: 1, label: "Right" },
    aimX: { min: 0, max: 31 },
  },

  counters: [{ name: "motes", direction: "up", monotonic: true }],
  rankBy: ["motes"],
  tiePolicy: "shared",

  params: { speed: { type: "int", label: "Speed", min: 1, max: 3, default: 1 } },
  assets: [{ path: "sprites.png", sha256: "...", bytes: 12345,
             requiredForSim: false, license: "CC0" },
           { path: "packs/rules.json", sha256: "...", bytes: 512,
             requiredForSim: true, license: "CC0" }],
  budgets: { bundleBytes: 2_000_000, microsecondsPerTick: 400 },
  capabilities: { deterministic: true, physics: "none",
                  renderer: "canvas2d", multiplayer: false },
}
```

`assertManifest` in the kernel validates it and is the only definition of the
schema. There is no second JSON Schema file, because two descriptions of one
shape drift and the one that drifts is the one nobody runs.

A few fields decide more than they look like they do.

`id` is immutable. Change it and it is a different game with a different
leaderboard, which is why the skill's scaffold sets it once at creation.

`version` is a semantic version, and its parts are a promise about the rules:
a patch changes how the game looks or fixes a bug and keeps what a score
means, a minor changes the rules, and a major is a different game. A platform
may treat every patch of one `MAJOR.MINOR` as the same game, ranking them on
one board, so a patch should keep the fields that decide how a run is played
and ranked (`session`, `inputs`, `counters`, `rankBy`, `tiePolicy`, `params`,
`capabilities`) as the line's first release declared them. A recording names
its exact version and replays against that version only.

`counters` and `rankBy` replace an objective system. An objective is
`counters[name] >= threshold`, computed by the platform, so a new kind of
objective is a new counter rather than new code on both sides. A counter
declared `monotonic` may never move the wrong way, and the suite checks every
tick.

`inputs` is everything the game records, each a name and the whole numbers it
carries. Which key, finger or stick drives an input is the game's page's
choice, made in code (see [Input](#input)); the manifest says only what is
recorded, and a server refuses a log holding anything else. Schema 1 bound
device codes here and declared on-screen controls; a schema 1 manifest is
refused and told what changed.

`params` are typed, validated against their ranges before the game sees them,
and arrive as the `config` argument to `init`. They travel in the recording, so
a replay applies the same values.

`assets` lists every file the game ships, art and [data packs](#data-packs)
alike. A path is relative and made of ASCII letters, digits, `.`, `_`, `-` and
`/`, with no `.` or `..` segment, and two paths that differ only in case are
one file. The rule is an allow-list because the checker reads each path under
the bundle's directory and a host builds a URL from it, and a deny-list for
`..` misses `%2e%2e`, which a URL parser turns back into `..`.

`budgets.microsecondsPerTick` sizes the CPU allowance the platform gives the
session. Declaring a number you do not meet fails a check; declaring a large one
costs you at submission. `budgets.assetBytes` caps the declared assets'
total. `budgets.bundleBytes` is accepted and not checked yet.

## Conformance

`@clockwork2/engine/validate` runs twelve checks. The same code runs locally and in the
submission pipeline, and the platform's own run is the one that decides.

```bash
bunx clockwork2-validate run ./src
bunx clockwork2-validate run ./src --only=determinism,restore
bunx clockwork2-validate run ./src --json
```

| # | Check | What it does |
| --- | --- | --- |
| 1 | determinism | Runs the same seed, config and inputs repeatedly, in the same process and in freshly evaluated modules, against idle, chaos and bot input logs; a game with `packsNeeded` runs once more with each demand pack handed over only when named |
| 2 | headless | `init` plus 600 ticks with no `window`, `document`, WebGL, `AudioContext` or `fetch` |
| 3 | bound | `isOver()` becomes true inside `maxTicks` under every log |
| 4 | banned-apis | Static scan of the import graph, plus the runtime traps |
| 5 | no-async | No `await`, `async` or `.then`; hashes state, drains microtasks, hashes again |
| 6 | restore | Snapshot, restore into a fresh module, continue, compare against an uninterrupted run |
| 7 | budgets | Every declared file present, its hash and size matching, the total inside `assetBytes` |
| 8 | performance | Per-tick cost against the declared budget, and peak memory |
| 9 | counters | Monotone counters never reverse, `isOver()` never flips back, values stay whole and inside 53 bits |
| 10 | replay | Record through the real recorder, serialise, deserialise, replay, compare |
| 11 | manifest | Schema validation, and the bundle touches no embedder global |
| 12 | render-smoke | The render bundle draws a canned state without leaving the frame |

Every failure carries a stable code, such as `E_RESTORE_MISMATCH@1380`. Catching
code switches on the code, never on the message. The codes are listed with their
causes and remedies in
[the skill's failure-modes reference](../skill/platform-game/references/failure-modes.md),
and a test compares that list against the kernel's table in both directions, so
a code cannot exist without an explanation.

Modules are evaluated afresh for each session rather than instantiated afresh. A
new instance does not reset a module-level counter, and a game that keeps static
ids relies on that without knowing.

Every check that runs the game gives it its data packs. `loadSubject` reads
each declared pack from its path under the bundle's directory, at most one byte
past its declared size, and the suite checks them once and shares the result,
so a missing or wrong pack is reported with its own code by every check that
runs the game. The extra determinism run for a game with demand packs hands
each one over only when `packsNeeded` names it, as a host that has to download
it would, and calls `packsNeeded` an extra time with the state hashed on either
side. A `packsNeeded` that changes state is reported as the cause.

The performance check times its run from the first tick, so setting up and
checking packs is not charged to a tick. In the same run it reports peak
resident memory, as `measurements.peakMemoryBytes`, beside the engine it was
measured on. The baseline is taken after a full collection and before the
session is built, because what `init` loads is the game's memory too, and the
peak is sampled every 60 ticks. It measures resident memory because the heap
counters do not see a typed array, and pack data is mostly typed arrays. Each
in a fresh process under Bun 1.4.4, a game holding nothing reported 13.3 MiB,
most of it the game's own module, and one holding a 32 MiB table 45.4 MiB.

## Embedding a game

`@clockwork2/engine/host` runs a game in a page. At its simplest:

```ts
const host = new GameHost({
  module: createGame(),
  manifest: MANIFEST,
  seed,
  config,
  presentation: createPresentation(),
  container,
  checkpointEvery: MANIFEST.session.tickHz,
  onEnded: (result) => submit(host.recording()),
})
// Optional: which keys and fingers drive the game's declared inputs. Only a
// replay has no live queue.
const live = host.live
if (live === null) throw new Error("a live session has a live input queue")
new InputCapture({
  manifest: MANIFEST,
  queue: live,
  element: container,
  keys: { ArrowLeft: "left", ArrowRight: "right" },
  pointers: [{ down: "tap", x: "aimX" }],
}).attach()
host.start()
```

The host owns the accumulator, the checkpoints and the recording. The game
knows about none of them. A game runs in its own page, on its own site; there is
no frame between the page and the game.

A game with data packs gives the host its start packs and a loader for the
rest:

```ts
const loader = fetchPackLoader({
  manifest: MANIFEST,
  url: (pack) => `/pack/${pack.sha256}`,
})
const host = new GameHost({
  ...rest,
  packs: { preloaded: await loadPacks(MANIFEST, loader), loader },
})
```

`fetchPackLoader` builds each URL from the manifest and the content's own
digest. It asks with `mode: "cors"` and no credentials, counts the body as it
arrives and stops past the declared size, and reports a refused or failed fetch
as `E_PACK_NOT_DELIVERED`.

The host holds its loop while a pack the game named is missing and reports
what it is waiting for in `FrameInfo.waitingFor`. A prefetch that fails is
forgotten and fetched again when needed. A needed pack that cannot be loaded,
or that the kernel refuses, ends the session through `onError`, and so does a
needed pack with no loader to fetch it, rather than a hold that never ends.
Anything a loader settles after the session ended is ignored. A platform that
issues sessions with a deadline has to allow for the longest hold in
`maxWallSeconds`.

### Watching a recorded run

A replay is a session whose inputs come from a log instead of from devices, so
it runs down the same loop and reaches the same states:

```ts
const host = new GameHost({
  ...rest,
  seed: recording.seed,
  inputs: new RecordedInputSource(recording.inputs),
  speed: 2,
})
```

`host.live` is null for a replay, which does the rest of the work by itself: the
device helpers have no queue to record into, so a key pressed by somebody
watching cannot reach the run they are watching. `speed` is for a replay; a
live session runs at 1, because speed on a live run is a player slowing the game
down to play it.

The simulation can also run in a worker with the clock staying on the page. The
renderer then holds a copy of the view rather than a reference to it, which is
the strongest possible form of "the renderer cannot write to the simulation".
One frame may be outstanding at a time; a newer frame replaces an older one that
has not been sent, so a page that falls behind skips frames instead of building
a queue of stale ones.

Packs reach a worker as transferred buffers: the start packs with `init`, and a
demand pack when the worker posts `packs-needed`. The page transfers a copy it
made for the purpose, exactly the pack's length, so a cache or a loader that
keeps the original is not emptied by the transfer. A worker that is holding
still answers every frame, with the same tick, or the page would never send
another and the hold would never end. `demo/packs.html` and
`demo/packs-worker.html` run a pack game both ways in a real browser, and
`e2e/specs/09-packs.spec.ts` replays each on a server.

## Writing a game with an agent

`skill/platform-game/` is an Agent Skill for coding agents. It carries ten rules
that each name the check enforcing them, a section per error code, four scripts,
and two starter templates that pass the whole conformance suite before anything
is changed.

```bash
bun run skill/platform-game/scripts/new.ts ./my-game
cd ./my-game && bun install && bun run validate
```

Its first line says that where its prose and `scripts/validate.sh` disagree, the
script is right. Everything in it that can be checked is checked by
`bun test skill`: the API reference is generated from the type declarations, the
error-code sections are compared with the kernel's table, and both templates are
run through the suite.

## Decisions

The reasoning behind choices that are otherwise easy to mistake for arbitrary.

**Fixed step, rather than recording frame deltas.** A variable-step engine can
be made to replay by recording the delta of every frame and replaying those
deltas. It works, and it has four properties a platform paying on results cannot
accept: the simulation depends on the player's frame rate, so two players on one
seed do not play the same game; the delta array comes from the client, so the
client decides how much simulation runs; a delta array is an input to validate,
and `NaN` in it stalls a replay; and replaying many small steps as one large
step is a different computation, because an interval timer that was skipped
fires repeatedly inside it.

**No delta array in the recording.** With a fixed step there is nothing to
record. Timing is the tick index on each input.

**An input's tick is stamped when it is queued**, against the tick about to run,
rather than when a frame drains the queue. Draining is frame-shaped, so stamping
at drain time makes the same keystroke land on different ticks at different
frame rates.

**Inputs are the game's own, by name and range, with no device.** Schema 1
bound device codes to actions and recorded which device each input came from,
and a platform drew on-screen controls from the manifest. A game now draws its
own controls, declares what it records, and maps devices onto those names in
its page. The engine keeps optional helpers for the common devices and a check
of a log against the declared inputs, and nothing about a device reaches a
recording.

**A merged input stays where the first one stood.** A level merged to the last
value of a tick overwrites the earlier entry in place rather than moving to the
end, so a pointer's position recorded before its press stays before it. The
cost is that a press is hit-tested at its pointer's last position in that tick,
at most one tick of finger travel.

**Games run in their own page.** The sandboxed-frame bridge, its message
protocol and the page-to-frame tilt forwarding are gone. A game runs on its
own site, so the keys, sensors, fullscreen and audio a page allows reach it
directly; the protections a frame gave a host serving strangers' code are not
needed when the page and the game are the same author's.

**The snapshot carries the generator's position.** The seed says where the
stream began and nothing about how far along it is, and a snapshot is a resume
point: restoring from the seed alone rewinds the generator to its first draw
while the rest of the world stays where it was, so the next apple is placed
from the first two numbers the stream ever produced. Conformance check 6 catches
it. A draw count would be one number where alea's state is four, but recovering
a position from it means calling alea that many times on every restore, because
there is no jump-ahead: 360 times for the demo's longest frozen recording, and a
game drawing per particle per tick would be into the millions. It also keeps the
checkpoint hashes sensitive to the generator. Two runs that have drawn a
different number of times differ at the next checkpoint, instead of at whatever
later tick a draw first moves something a player can see.

**The generator's seed lives in its exported state.** A sub-stream is derived
from its parent's seed, so a module that restores a snapshot and then opens a
sub-stream it had not opened before would otherwise derive it from the restoring
module's seed and diverge.

**Effects are drained, not called.** See
[Sound and other effects](#sound-and-other-effects).

**The kernel has zero runtime dependencies** and its `package.json` has no
`dependencies` key. Alea is vendored with attribution in `NOTICE`. A kernel that
pulls a tree of packages into every game is a kernel whose determinism depends
on packages it does not control.

**`view()` exists separately from `snapshot()`.** A plain-data copy of the whole
world every tick is the entire frame budget in a 3D game. `view` can hand back a
live reference; `snapshot` is the copy, taken when something needs one.

**`restore()` exists** because without it there is no save, no resume, no
partial replay, and no way to test that a snapshot is complete.

**Checkpoints are evidence, not input.** Replay does not read them, so a
recording with tampered checkpoints still replays and the tamper is what shows
up.

**A pack becomes readable at a step the game names, not when it arrives.** The
first design let a game read any pack that had been delivered. That works
until two hosts deliver at different times, and then a game that read a pack
one tick early on a fast connection computes something the server does not.
Making readability a function of state, through `packsNeeded`, removes the
case instead of testing for it.

**The set of readable packs is recomputed each tick, not accumulated.** An
accumulated set depends on everything the run named before, which a snapshot
does not carry, so a restored session could read less than the run it resumed.

**`packsNeeded` runs once per tick, everywhere.** A host that holds asks what is
missing as often as it likes, and gets the answer the kernel already has. If
the call count varied between hosts, a `packsNeeded` with a side effect would
diverge only in browsers on slow connections.

## Open questions

Carried deliberately, not resolved.

Physics is out. Custom kinematics only for now. A deterministic Rapier build
exists (`@dimforge/rapier2d-deterministic`, not the default package, which has
not been deterministic since rapier.js 0.15.0) and it belongs in a later package
after a two-machine hash test.

Memory has a measurement and no budget. The performance check reports peak
resident memory for one run on JavaScriptCore under Bun. A V8 isolate, where a
server replay may run, uses a different amount, and nothing here measures one
yet, so a platform sizing replay workers should measure in its own.

Tilt is checked on one phone and half-checked on one tablet, with
`demo/tilt.html`, which walks a person through each pose and copies what it
recorded. On a Galaxy S24+ under Chrome 157 every pose read as it should,
upright and on its side, and readings kept arriving at about 59 a second while
the page scrolled. An iPad Pro (2018) under iPadOS Safari 26.6 reported
`screen.orientation.angle` 90 while held in portrait, with `window.orientation`
0, and its readings were measured against 0, so every tilt came out a quarter
turn wrong. Held on its side it reported 180 against a `window.orientation` of -90,
and its readings matched -90; loaded while held sideways, its screen's angle
was 0 and `window.orientation` 90. Safari on an iPad measures the screen's
angle from landscape and its readings from portrait. The helpers now read
`window.orientation` where a browser has it, and a second run passed every
pose. Whether WebKit keeps sending readings while a page scrolls is not yet
measured, and no iPhone has been checked.

The input budget is a model's. `INPUT_BUDGET_PER_TICK` is 16, four times the
busiest rate scripted runs of each helper produced, not a rate measured from
real players, and a recording of a real hand, or a game mapping several
devices at once, may need it revisited.

The demo is the only substantial game on the engine so far. Games are rewritten
against this API rather than adapted onto it, so a larger one would answer two
questions together: what a rewrite of that size costs, and whether the kernel
asks for the right things. It asks for a `tick()` that is the only writer, state
plain enough to hash, and a snapshot complete enough to restore.

## Related documentation

- [README](../README.md), for what the project is and how to run it
- [The agent skill](../skill/platform-game/SKILL.md), for writing a game
- [Failure modes](../skill/platform-game/references/failure-modes.md), one
  section per error code
- [The kernel API](../skill/platform-game/references/kernel-api.md), generated
  from the type declarations
