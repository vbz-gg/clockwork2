# Assets and data packs

Every file a game ships is declared in the manifest with its sha256 and byte
count. Check 7 reads each declared file and fails on a wrong hash, a wrong
size, a declared file that is missing, or a total over `budgets.assetBytes`.
It reads declared files only, so a file the manifest leaves out is not
reported.

```
scripts/package.ts ./dist                                 print the array
scripts/package.ts ./dist --manifest=./src/manifest.ts     compare with declared
```

`package.ts` prints a file under `packs/` as a data pack and anything else as
art.

## Art and packs

`requiredForSim` says whether the *simulation* reads the file. A texture, a
model or a sound is `false`: it is art, the renderer loads it, and nothing it
loads can change a result. A level layout the simulation walks, a table of
vehicle stats, the map of a town: those are `true`, and that makes the file a
data pack.

The platform replays a run with the packs of the version the run was issued
for and never loads art. A game that marks a pack `false` replays without it
and fails; a game that marks art `true` makes every replay fetch and check
files it never reads.

## Start and demand packs

```ts
assets: [
  { path: "packs/rules.json", sha256: "...", bytes: 512,
    requiredForSim: true, license: "CC0" },                 // a start pack
  { path: "packs/harbor.json", sha256: "...", bytes: 90210,
    requiredForSim: true, load: "demand", license: "CC0" }, // a demand pack
]
```

A **start** pack, the default, is in hand before the session begins. `init`,
`restore` and every tick can read it.

A **demand** pack arrives later, when the game asks for it. A tick can read
it only when `packsNeeded()` named it just before that tick. While a pack the
game named is missing, the host holds the loop: no tick runs, time is not
banked, and the run carries on from the same tick once the bytes are here.
That is what keeps a slow download from changing a run. The tick a game first
reads a pack is the same in a browser, in a worker and on the server, however
long each took to fetch it.

## Reading a pack

`init` receives the reader as its third argument. Keep it.

```ts
init(seed: string, config: Config, packs: PackReader): void {
  this.packs = packs
  this.rules = packs.json("packs/rules.json") as Rules
  this.town = null
}

tick(inputs: readonly InputEvent[]): void {
  if (this.inHarbor()) {
    // Opened once and kept, outside the snapshot.
    this.town ??= this.packs.json("packs/harbor.json") as Town
  }
}

packsNeeded(): readonly string[] {
  return this.inHarbor() ? ["packs/harbor.json"] : []
}
```

- `packs.open(path)` returns the bytes as a new `Uint8Array` on every call.
  Writing into it changes nothing anywhere else.
- `packs.json(path)` decodes the bytes as UTF-8 with the engine's own decoder
  and parses them as JSON. It refuses invalid UTF-8, invalid JSON, a pack over
  536,870,888 bytes, and any number with more than 20 significant digits,
  because ECMAScript lets each engine round a longer one its own way.
- `packsNeeded()` is a pure function of state. The kernel asks it once after
  `init`, once after `restore` and once after every tick, in every host, and
  the answer decides what the next tick may read. It must not change anything
  all the same: the determinism check calls it an extra time and compares the
  state on either side of the call.
- Nothing tells a game whether a pack has arrived. That is deliberate: a game
  that could ask could behave differently on a fast connection.

## Where a game may read

| Where | Start packs | Demand packs |
|---|---|---|
| `init` | yes | no |
| `restore` | yes | no |
| a tick | yes | only those `packsNeeded()` named before it |
| `view`, `snapshot`, `score`, `isOver`, `packsNeeded` | no | no |

A read outside the table is `E_PACK_NOT_REQUESTED`. Copy what the renderer
needs into the state `view()` returns rather than reading a pack there.

## Snapshots

A snapshot holds pack names and positions, never pack contents. After a
restore, open the pack again on the first tick that needs it; `packsNeeded()`
names it from the restored state, so it is readable there.

A `restore` that calls `init` to rebuild timer handlers has to pass the reader
back: `this.init("restored", config, this.packs)`.

## Hinting

Emit `{ type: "prefetch", data: "packs/harbor.json" }` from `effects()` a few
seconds before the game will need a pack. The host starts loading it, so the
pack is usually there before the hold would begin. `data` can also be an array
of paths. The kernel checks every name, so an undeclared one fails the run at
the same tick everywhere. A hint that arrives late changes nothing but whether
the loop waits.

## Where packs live

The validator reads each pack at its `path` under the directory it is given,
and `package.ts` hashes what is under the directory you ship. Keep every pack
at the same relative path in both, for example `src/packs/` and `dist/packs/`.

## What can go wrong

| Code | Meaning |
|---|---|
| `E_PACK_UNDECLARED` | a name that is not a declared pack |
| `E_PACK_NOT_REQUESTED` | a read the table above does not allow |
| `E_PACK_NOT_DELIVERED` | a pack the session needed never arrived |
| `E_PACK_HASH_MISMATCH` | the bytes are not the ones declared |
| `E_PACK_TOO_LARGE` | the file is longer than its declared `bytes` |

`failure-modes.md` has the causes and fixes for each.

## Art

The renderer may load whatever it likes, whenever it likes, because nothing it
loads can change a result. The host hands it an `assets` map in its
`PresentationContext`; loading late is a visual problem, not a correctness
one.

## Procedural first

Audio and simple textures are worth generating rather than shipping. The demo
in this repository synthesises all of its sounds, so it ships no audio files
at all, and `AudioSink` takes a recipe rather than a URL. That is smaller, it
cannot 404, and there is no licence to declare.

The one rule: generate them in the *presentation*. A waveform built with
`Math.sin` and `Math.random` is fine there and banned in the simulation, and
a sound has no business being part of the state anyway.

## Licences

Every declared asset carries a `license` string. The platform reads it; a
missing one is a failed check rather than a warning.
