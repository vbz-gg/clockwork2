# @clockwork2/adapter-canvas2d

A read-only presentation adapter for [Clockwork 2](https://github.com/vbz-gg/clockwork2)
that draws to a 2D canvas.

```ts
import { Canvas2dPresentation } from "@clockwork2/adapter-canvas2d"
```

A presentation reads the simulation's view and writes nothing, so it may use
everything the simulation may not: `Math.random`, `performance.now`, the DOM,
audio, the network. None of it is read back, so none of it can change a result.

Interpolate with the `alpha` the host passes, or the drawing judders on any
display whose refresh rate is not a multiple of the tick rate.

MIT.
