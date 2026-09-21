# @clockwork2/kernel

The simulation kernel behind [Clockwork 2](https://github.com/vbz-gg/clockwork2):
a fixed-step loop, deterministic maths, seeded randomness and recordings that
replay to the same bits on V8, JavaScriptCore and SpiderMonkey.

It has no runtime dependencies and imports no DOM types. Everything it needs is
vendored, with attribution in the repository's NOTICE.

```ts
import { Prng, runSession } from "@clockwork2/kernel"
import * as dmath from "@clockwork2/kernel/dmath"
```

A game implements eight methods and no base class: `init`, `tick`, `view`,
`snapshot`, `restore`, `score`, `isOver`, `effects`. `tick()` takes no time
delta, so a simulation cannot depend on the player's frame rate.

`Math.sin`, `Math.pow` and the rest of the transcendentals are
implementation-defined, and they really do differ: `Math.cos(0.1)` is
`0x3FEFD712F9A817C1` on JavaScriptCore and `0x3FEFD712F9A817C0` on V8.
`dmath` ships the same function names, transcribed from fdlibm using only
operations ECMAScript specifies exactly.

`docs/engine.md` in the repository explains the whole design from first
principles.

MIT.
