# Lane Runner 3D (three)

The same game as the `canvas2d` template, rendered with Three.js. `src/sim.ts`
is byte-identical between the two, which is the point worth taking from this
template: the renderer is a choice, the simulation is not.

```
bun install
bun run validate     # the conformance suite; this passes before you change anything
bun run dev          # play it
```

## Where the boundary is

| File | Side | May use |
|---|---|---|
| `src/sim.ts` | simulation | the kernel, `dmath`, `Prng`, `Timer`, plain arithmetic |
| `src/manifest.ts` | data | nothing; it is a value |
| `src/index.ts` | the bundle's entry | re-exports the two above |
| `src/present.ts` | renderer | anything - Three's math, `Math.random`, WebGL |
| `src/main.ts` | page | the host bridge and the browser |

Three's `Quaternion` and `Euler` call `Math.sin` and `Math.cos`, and `Clock`
reads `performance.now`. All three are fine in `present.ts` and would fail
`validate` in `sim.ts`. That is not a quirk of the checker: those functions are
implementation-defined, and a simulation that used one would reach a different
state on the server that replays it.

Three's own animation loop is never started. The host decides when a frame
happens and the adapter renders once per frame, so a slow display draws fewer
frames and simulates exactly the same ticks.

## Changing it

Read `references/determinism-rules.md` before editing `sim.ts`, and run
`bun run validate` after. The renderer has no rules beyond reading and not
writing.
