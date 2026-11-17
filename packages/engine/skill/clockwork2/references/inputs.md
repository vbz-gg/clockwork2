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
queue merges a level to its last value in a tick and sums an amount, in place;
a position that moves after a press in the same tick is kept after the press,
so the press keeps where the finger went down.

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

Do not let the page scroll during a run of a game that reads tilt. Measured on
an iPad Pro (2018), orientation readings fell from 59 a second to between 1
and 5 while the page scrolled under iPadOS Safari 26.6, and to a lowest of 2
and an average of 9 under 26.7, so the game would steer by a reading up to
half a second old. When it hears pointers, `InputCapture` sets
`touch-action: none` on its element, which keeps a drag there from scrolling;
a game that reads only tilt sets it itself. Keep the game's element filling
the view, and nothing else on the page scrollable, while a run plays.

Tilt needs the player's permission on iOS, and the request has to come from a
tap. Call `requestMotion()` as the first thing the Play button's click does,
before anything is awaited, and start the run after it answers. It resolves
granted once a first real reading arrives, or with a refusal saying why:
`E_MOTION_INSECURE` (the page is not on https), `E_MOTION_UNSUPPORTED`,
`E_MOTION_DENIED` (the player said no), `E_MOTION_BLOCKED` (the page's
permissions policy) or `E_MOTION_NO_SENSOR`. Show the player the reason.
iOS remembers a refusal for the site until its website data is cleared, so
asking again on the next tap gets the same answer. A run started anyway
records no tilt, so a game that reads tilt should start no run without it;
a page built with the vbz kit starts none.

## What recordings cost

Measured rather than estimated, so the advice above has numbers behind it. The
coarse range halves two thumbs and tilt and cuts trackpad flings by 82%; it
saves 4% on a swept stick and nothing on a notched wheel, which records whole
notches either way. Every input costs about 40 bytes of JSON, its name
included, so a short name is a smaller recording too.

Produced in the clockwork2 repository by `bun run scripts/measure-inputs.ts`. Each row is one run of 18000 ticks (five minutes at 60 Hz) in a real `GameHost` driven by a `ManualScheduler`, one animation frame of 1000/60 ms per tick (18001 frames for the first row), under bun 1.3.11, importing the engine from `packages/engine/src`. The real `InputCapture` is attached to the host's live queue through a fake browser; before each frame the model player below sends the events a browser would deliver, then the frame runs and the queue stamps what is pending onto the frame's tick.

- **Inputs** is the length of `recording.inputs` at the end.
- **Per tick** is inputs over the run's end tick.
- **Peak per tick** is the most inputs in any 120 consecutive ticks, the window sliding one tick at a time, over 120.
- **Recording bytes** is the UTF-8 length of `encodeRecording(host.recording())`: the inputs, a checkpoint every 60 ticks, the counters and the rest of the envelope. The baseline row is the same run with nothing pressed.
- **Gzipped** is that text through node's `gzipSync` at its default level.
- **Log bytes per input** is the UTF-8 length of `JSON.stringify(recording.inputs)` over its inputs. An input's name is in every one of them, so a shorter name is a smaller recording.
- **Within budget** is whether `checkInputs` accepts the log against its manifest at the current `INPUT_BUDGET_PER_TICK` of 16.
- Randomness (key timings, tilt noise) comes from a `Prng` seeded with the scenario's name, so a rerun gives the same table.

| Scenario | Declared | Inputs | Per tick | Peak per tick (120-tick window) | Recording bytes | Gzipped | Log bytes per input | Within budget of 16 |
|---|---|---:|---:|---:|---:|---:|---:|---|
| Nothing pressed | one press declared | 0 | 0.000 | 0.000 | 12582 | 4172 | 0.0 | yes |
| Two thumbs | x 0 to 63, y 0 to 29 (about 13 px a step) | 33601 | 1.867 | 1.908 | 1383870 | 126852 | 40.8 | yes |
| Two thumbs | fine: x and y 0 to 1000 | 70378 | 3.910 | 3.917 | 2959835 | 307440 | 41.9 | yes |
| Stick swept | each axis -100 to 100 | 32814 | 1.823 | 1.858 | 1383489 | 115286 | 41.8 | yes |
| Stick swept | fine: each axis -1000 to 1000 | 34225 | 1.901 | 1.925 | 1475857 | 123075 | 42.8 | yes |
| Mouse under lock | 4 px a unit, -32 to 32 a tick | 22870 | 1.271 | 1.292 | 917512 | 66834 | 39.6 | yes |
| Mouse under lock | fine: 1 px a unit, -1000 to 1000 a tick | 33888 | 1.883 | 1.883 | 1355158 | 100312 | 39.6 | yes |
| Wheel in bursts | 1 notch a unit, -10 to 10 a tick | 1201 | 0.067 | 0.100 | 59261 | 8666 | 38.9 | yes |
| Wheel in bursts | fine: 1 px a unit, -1000 to 1000 a tick | 1201 | 0.067 | 0.100 | 61663 | 8679 | 40.9 | yes |
| Trackpad flings | 1 notch (100 px) a unit, -10 to 10 a tick | 1101 | 0.061 | 0.100 | 55373 | 8357 | 38.9 | yes |
| Trackpad flings | fine: 1 px a unit, -1000 to 1000 a tick | 5996 | 0.333 | 0.500 | 250247 | 28510 | 39.6 | yes |
| Tilt in the hand | x and y -100 to 100, full at 45 degrees | 14809 | 0.823 | 1.117 | 618884 | 67287 | 40.9 | yes |
| Tilt in the hand | fine: x and y -1000 to 1000, full at 45 degrees | 30530 | 1.696 | 1.958 | 1294231 | 143920 | 42.0 | yes |
| Keys mashed | four presses, 0 to 1 (a press has no finer range) | 19207 | 1.067 | 1.167 | 754558 | 68919 | 38.6 | yes |

### What each model player does

- **Nothing pressed**, on a 1280 by 720 CSS px element: no events at all, so this is what a recording costs before inputs.
- **Two thumbs**, on a 844 by 390 CSS px element: two fingers go down at once and never lift; each traces a circle of 80 px radius, one every 0.75 s (670 px/s) and one every 1 s (503 px/s), one pointermove per finger per frame.
- **Stick swept**, on a 1280 by 720 CSS px element: the left stick's x follows sin(2 pi t / 1 s) at full deflection and its y 0.6 sin(2 pi t / 1.7 s), read once a frame.
- **Mouse under lock**, on a 1280 by 720 CSS px element: one pointermove per frame, movementX cycling 2, 3, 4, 5, 6 px (240 px/s across) and movementY round(3 sin(2 pi t / 2 s)) px, sweeping up and down.
- **Wheel in bursts**, on a 1280 by 720 CSS px element: every 3 s, 12 notches of 100 px one every 2 frames (30 notches/s), the direction alternating between bursts.
- **Trackpad flings**, on a 1280 by 720 CSS px element: every 3 s, a one-second fling: one wheel event a frame whose deltaY falls from 40 px to 1 px, the direction alternating between flings.
- **Tilt in the hand**, on a 844 by 390 CSS px element: 60 readings a second: beta 35 + 12 sin(2 pi t / 5 s) and gamma 15 sin(2 pi t / 3.7 s) degrees, each reading plus normal noise of 0.25 degrees standard deviation.
- **Keys mashed**, on a 1280 by 720 CSS px element: four keys mashed at once, each held 3 to 5 frames and let go 2 to 5 frames, drawn at random: about 8 presses a second a key, 32 in all.
