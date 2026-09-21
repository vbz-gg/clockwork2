# @clockwork2/adapter-three

A read-only presentation adapter for [Clockwork 2](https://github.com/vbz-gg/clockwork2)
that draws with Three.js.

```ts
import { ThreePresentation } from "@clockwork2/adapter-three"
```

Three's animation loop is never started: the host decides when a frame is
drawn. Three's maths helpers stay on this side of the boundary too, and that
matters more than it looks - `Quaternion.setFromEuler` calls `Math.sin` and
`Math.cos`, and `angleTo` calls `Math.acos`, none of which agree across
JavaScript engines. In a renderer they are free. In a simulation they would
make the run unverifiable.

`three` is a peer dependency.

MIT.
