# Renderers

A renderer implements `Presentation<TView, TContainer>`: `mount`, `render`,
`unmount`, and `prepare` when it starts asynchronously. The host calls
`render(view, previousView, alpha, dtMs)` once per frame, whatever number of
ticks that frame ran.

It reads. It does not write. Not to the view, not to the simulation, not
anywhere the simulation can read back. That is the entire contract, and it is
what makes it safe for a renderer to use `Math.random`, `performance.now`,
Three's `Quaternion` and anything else that is off-limits on the other side.

## A renderer that has to get ready

A renderer that cannot draw as soon as `mount` returns, because it spawns
workers, compiles a WebAssembly core, builds shaders or asks for a GPU,
implements `prepare(container, context): Promise<void>` and resolves it once
it can draw. `GameHost.start()` mounts it, calls `prepare`, and starts the
session's clock only when `prepare` resolves: no tick runs before that, and the
live queue takes no input, so a player is never playing a game they cannot
see. `start()` returns a promise of `true` once the clock runs.

A rejection means this device cannot draw the game. The host reports it
through `onError` as `E_PRESENTATION_FAILED`, carrying the presentation's own
message, `start()` resolves `false`, and the session never starts. A host
stopped or destroyed while `prepare` runs starts nothing when it settles.

Of the three adapters here, PIXI is the one that starts asynchronously: its
`Application.init` is a promise, so `PixiPresentation` has a `prepare` that
waits for it, and a device where init fails gets `E_PRESENTATION_FAILED`
before tick 0. canvas2d and three start inside `mount`: canvas2d takes its 2d
context and three builds its `WebGLRenderer` there, synchronously, so they
have no `prepare`, `start()` starts the clock before it returns, and a device
that cannot draw them makes `mount`, and so `start()`, throw before any tick
runs.

## The four arguments

- `view` - what `view()` returned after the last tick.
- `previousView` - what it returned the tick before, or `null` on the
  first frame.
- `alpha` - how far between them this frame sits, in `[0, 1)`.
- `dtMs` - real milliseconds since the previous frame.

`alpha` is the one people skip, and skipping it is why a 60 Hz simulation
looks wrong on a 144 Hz display: two frames in a row draw the same tick, then
one jumps. Interpolate positions between the two views with it.

`dtMs` is legitimate here precisely because nothing reads it back. A particle
system driven by `dtMs` looks right at every frame rate and cannot change a
score.

## `@clockwork2/engine/adapter-canvas2d`

```ts
new Canvas2dPresentation<View>({
  width: 480,
  height: 720,
  background: "#0b1020",
  draw: (context, { view, previousView, alpha }) => { /* ... */ },
})
```

The adapter owns the canvas, the device-pixel scaling and the clear. The game
owns one `draw`. `maxPixelRatio` defaults to 2, because a phone at 3x costs
nine times the pixels for very little.

## `@clockwork2/engine/adapter-three`

```ts
new ThreePresentation<View>({
  width: 480,
  height: 720,
  onReady: ({ scene, camera }) => { /* lights, camera */ },
  draw: ({ scene }, { view, previousView, alpha }) => { /* ... */ },
})
```

Three's own animation loop is never started: the host decides when a frame
happens and the adapter renders once. Keep objects in a map keyed by the
simulation's ids, create on first sight, remove when the view stops mentioning
them - rebuilding the scene each frame works and is slow.

## `@clockwork2/engine/adapter-pixi`

The same contract with a PIXI `Application`, `autoStart: false`. The demo in
this repository uses it. `prepare` waits for PIXI's asynchronous init, so a
host starts no tick before PIXI can draw.

## Nodes by id

Every renderer faces the same small problem: the view is a list and the scene
is a set of objects. `NodeSet` does the diff - create on first sight, update
while present, destroy when gone. It lives in the kernel and all three
adapters re-export it, so `import { NodeSet } from "@clockwork2/engine/adapter-three"`
works and there is no fourth copy of those forty lines anywhere.

```ts
const rocks = new NodeSet<Rock, Mesh>({
  id: (rock) => String(rock.id),
  create: () => new Mesh(geometry, material),
  update: (node, rock) => node.position.set(x(rock), 0, rock.z),
  destroy: (node) => scene.remove(node),
})
rocks.sync(view.rocks)
```

A renderer that instead reads a flag off a simulation object and clears it is
writing to the simulation. That holds together while one frame runs exactly one
tick, and breaks the moment a frame runs two, or a second view of the same world
appears.

## Effects

Sounds, rumbles and camera shakes are `Effect` values the simulation returns
from `effects()`, drained by the host each frame. They are not called inside
`tick()`, for two reasons: a headless replay would have to stub the call, and
a frame that runs two ticks would otherwise play the sound twice.

`AudioSink` in `@clockwork2/engine/host` turns effects into sound, including
procedurally generated ones, so a game can ship without audio files.

## Worker mode

The host can run the simulation in a worker, with the clock staying on the
page. The renderer then physically holds a copy of the view rather than a
reference to it - the strongest possible form of "the renderer cannot write to
the simulation".

The one thing a game must do to work in both modes is return a
structured-cloneable `view()`: plain data, no class instances, no functions.
A view full of class instances cannot be sent anywhere, so this is worth doing
regardless.
