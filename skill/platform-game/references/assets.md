# Assets

Every file a game ships is declared in the manifest with its sha256 and byte
count. Undeclared, wrong hash, or declared-and-missing each fail check 7.

```
scripts/package.ts ./dist                                 print the array
scripts/package.ts ./dist --manifest=./src/manifest.ts     compare with declared
```

## `requiredForSim`

The flag says whether the *simulation* reads the file. A texture is `false`. A
level layout the simulation walks is `true`.

It matters because the validator fetches the `true` ones before replaying and
ignores the rest. A game that marks a required file `false` replays against
nothing and diverges; a game that marks everything `true` makes every
validation slower and more expensive than it needs to be.

## Loading

The simulation may not fetch. Anything it needs is either in the bundle as
data or arrives as `config`, which means it is in the recording and the
validator has it too.

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
