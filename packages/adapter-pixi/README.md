# @clockwork2/adapter-pixi

A read-only presentation adapter for [Clockwork 2](https://github.com/vbz-gg/clockwork2)
that draws with PIXI 8.

```ts
import { PixiPresentation } from "@clockwork2/adapter-pixi"
```

PIXI's own ticker is never started. The host decides when a frame is drawn,
because the loop belongs to the simulation's clock and not to the renderer's.
Clockwork 1 put replay speed on the PIXI ticker, which made how fast the game
ran a property of the thing drawing it.

`pixi.js` is a peer dependency.

MIT.
