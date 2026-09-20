# Lane Runner (canvas2d)

Three lanes, rocks coming at you, motes to collect. Small on purpose: what it
demonstrates is the boundary, not the game.

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
| `src/present.ts` | renderer | anything - `Math.random`, `Math.sin`, the DOM, WebGL |
| `src/main.ts` | page | the host bridge and the browser |

`validate` is pointed at `src/`, follows the imports out of `src/index.ts`,
and fails if that graph can reach a banned API. That is why `index.ts` does
not import `present.ts`.

## Changing it

The simulation is the part with rules. Read `references/determinism-rules.md`
before editing `sim.ts`, and run `bun run validate` after. The renderer has no
rules beyond reading and not writing, so start there if you only want it to
look different.
