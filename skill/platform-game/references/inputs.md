# Inputs

A recording is the seed, the config and a list of inputs. The inputs are the
only part that grows with play, so what a game records decides how big every
recording is, how much a server stores, and how long a replay takes to read.
This page is about choosing what to record. The API is in `kernel-api.md`, and
`docs/engine.md` in the engine's repository has the design under "Input".

## What an input is

A game declares its inputs in the manifest, each a name and a range of whole
numbers:

```ts
inputs: {
  left: { min: 0, max: 1, label: "Left" },   // a press: 1 down, 0 up
  aimX: { min: 0, max: 31 },                  // a position, in 32 steps
  steer: { min: -10, max: 10 },               // a stick or a tilt
}
```

A recorded input is `{ tick, code, value }`: the tick the simulation is about
to run, a declared name, and a whole number in its range. There is no device
in it. Which key, finger, stick or tilt drives `left` is decided in the game's
page, in code, and the game may draw whatever on-screen controls it likes.

The live queue throws `E_INPUT_UNDECLARED` the moment a page pushes a name the
manifest does not declare or a value outside its range. A server holds a
submitted log to the same rules with `checkInputs`, and refuses a log holding
more than `INPUT_BUDGET_PER_TICK` inputs per tick on average with
`E_INPUT_BUDGET`. Both mean the page recorded something it should not have.

## Choosing what to record

**Record what changed, never a stream of readings.** A tilt sensor reports
sixty times a second whether or not the phone moved, and a pointer reports on
every pixel it crosses. Pushing each reading as an input records a
never-ending stream of numbers, most of them the same as the one before. Push
a level (a position, a stick, a tilt) only when its value changes, and an
amount (wheel notches, mouse movement while locked) as the change since the
last tick. An unchanged reading is not an input.

**Declare the coarsest range the game needs.** The range is the recording's
resolution. A finger moving slowly across a screen measured in 32 steps
crosses a step every few frames; measured in 1000 it crosses one every frame.
If the game only needs to know which of eight lanes a finger is over, declare
`{ min: 0, max: 7 }`.

**Keep one value per tick.** The simulation reads inputs once a tick, so three
stick readings between two ticks are one input: where the stick ended up. The
queue merges a level to its last value in a tick and sums an amount, in place.

**Record a value sized for the game, not the raw reading.** A steer from -10
to 10, worked out from the tilt in the page, records far less than three
gravity axes from -100 to 100, and replays the same, because the simulation
only ever read the steer.

**Leave out what the game does not read.** A hover position, a third tilt axis
or a second stick costs inputs whether or not `tick` looks at it, and a server
stores every one.

**Use a deadband for anything that drifts.** A stick at rest and a phone on a
table both wobble by a unit or two. Without a deadband the wobble is a stream
of changes.

`InputCapture` records only what its mapping names, only when a value changes,
one value per tick, in each name's declared range, with a deadband on sticks
and tilt. A game recording its own inputs by pushing to `host.live` has to do
all of that itself.

## Deciding a hit belongs in `tick`

A game whose page worked out that a tap landed on a target, and recorded only
"hit", would replay perfectly and still have decided the result where nothing
checks it. Record where the finger was, in a range coarse enough to be cheap
and fine enough to aim with, and hit-test in `tick`. The same goes for any
control the game draws itself: record the press and the position, and let the
simulation decide what was under it.

## The device helpers

`InputCapture` in `@clockwork2/engine/host` records the common devices
through a mapping in the game's code:

```ts
const live = host.live            // null only in a replay
if (live === null) throw new Error("a live session has a live input queue")

new InputCapture({
  manifest: MANIFEST,
  queue: live,
  element: canvas,                // pointers and the wheel are heard here
  keys: { ArrowLeft: "left", KeyA: "left" },
  pointers: [{ down: "tap", x: "aimX" }],
  tilt: { x: "steer", fullAt: 30 },
  onNotice: (notice) => showTo(player, notice),
}).attach()
```

`checkCapture(mapping, manifest)` checks a mapping without attaching it, so a
page can run it before it starts a run. Every press the helpers record they
also release: on pointer up or cancel, when the browser takes a finger away
for a scroll, on window blur, on a hidden tab, on a pause, and when a
controller is unplugged.

Tilt needs the player's permission on iOS, and the request has to come from a
tap. Call `requestMotion()` as the first thing the Play button's click does,
before anything is awaited, and start the run after it answers. It resolves
granted once a first real reading arrives, or with a refusal saying why:
`E_MOTION_INSECURE` (the page is not on https), `E_MOTION_UNSUPPORTED`,
`E_MOTION_DENIED` (the player said no), `E_MOTION_BLOCKED` (the page's
permissions policy) or `E_MOTION_NO_SENSOR`. Show the player the reason and
let them play with another control.
