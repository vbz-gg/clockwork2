# @clockwork2/host-bridge

The browser half of [Clockwork 2](https://github.com/vbz-gg/clockwork2): the
loop that drives a simulation, the input capture that feeds it, and the
protocol for running a game you do not trust.

```ts
import { GameHost, InputCapture } from "@clockwork2/host-bridge"
```

`requestAnimationFrame` is the pump, not the clock. Real elapsed time goes into
an accumulator and comes out as whole ticks, and the leftover fraction reaches
the renderer as an interpolation factor it may only read. Frame jitter changes
how many ticks a frame runs, never how big one is.

Subpaths keep the halves apart. `./parent` runs in the platform's page and puts
the game in an iframe with `sandbox="allow-scripts"` and no
`allow-same-origin`. `./frame` runs inside that frame and builds the session
when the parent sends a seed, so the seed never travels in a URL. `./worker`
moves the simulation off the main thread, which is the strongest form of "the
renderer cannot write to the simulation". `./protocol` is the message table
both sides read, and it has no row that carries a token, a URL or another
player's data.

MIT.
