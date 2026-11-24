# The manifest

A JSON-shaped value the platform reads *without running the game*. That is the
whole reason it exists: everything that decides how a session is run and
ranked is data, so a platform can decide whether to run untrusted code before
running it.

`assertManifest` from `@clockwork2/engine` is the schema. There is no separate
JSON Schema file in this guide, on purpose: two descriptions of one shape
drift, and the one that drifts is always the one nobody runs. The full type is
in `kernel-api.md`, which is generated from the declarations.

## The shape

```ts
{
  schemaVersion: 3,          // the format; 3 is the only one this engine reads
  id: "lane-runner",          // immutable across every version of this game
  version: "1.0.0",           // semantic: a patch keeps the rules
  name: "Lane Runner",
  kernel: { version: "0.1.0" },
  genres: ["arcade"],         // optional

  session: {
    tickHz: 60,               // 30, 60 or 120
    hasEnding: true,          // describes the game; nothing reads or checks it
    seats: 2,                 // optional: players taking turns, 1 to 8; 1 if left out
  },

  inputs: {                   // what the game records, by name and range
    left: { min: 0, max: 1, label: "Left" },
    right: { min: 0, max: 1, label: "Right" },
  },

  counters: [
    { name: "motes", direction: "up", monotonic: true },
    { name: "ticksSurvived", direction: "up", monotonic: true },
  ],
  rankBy: ["motes", "ticksSurvived"],   // optional, with tiePolicy; later ones break ties
  tiePolicy: "shared",

  params: {                   // what an operator may configure
    speed: { type: "int", label: "Speed", min: 1, max: 3, default: 1 },
  },

  assets: [                   // every shipped file, hashed
    { path: "sprites.png", sha256: "...", bytes: 12345,
      requiredForSim: false, license: "CC0" },
    { path: "packs/rules.json", sha256: "...", bytes: 512,   // a start pack
      requiredForSim: true, license: "CC0" },
    { path: "packs/harbor.json", sha256: "...", bytes: 90210, // a demand pack
      requiredForSim: true, load: "demand", license: "CC0" },
  ],

  budgets: { assetBytes: 200_000, microsecondsPerTick: 400 },
  display: { orientation: "any", minViewport: { width: 320, height: 480 } },
  capabilities: {
    deterministic: true,      // always; a manifest saying otherwise is refused
    physics: "none",
    renderer: "canvas2d",     // or "three", "pixi", "dom"
    multiplayer: false,       // always: nobody plays at the same time as anyone else
  },
}
```

## The fields worth thinking about

`id` is immutable. Change it and it is a different game with a different
leaderboard. This guide's `scripts/new.ts` sets it from the directory name
once, at creation, rather than leaving it to be edited later and forgotten,
and the vbz kit's scaffold does the same for a vbz game.

`counters` and `rankBy` replace an objective system. An objective is `counters[name] >= threshold`,
computed by the platform, not by the game. A game that wants a new kind of
objective declares a new counter; it does not ship an operator. Everything in
`rankBy` must be declared in `counters`. `counters` is required, with at least
one, because the kernel reads them every tick.

`rankBy` and `tiePolicy` say how a ranked run is ordered, and they come as a
pair: a manifest with one and not the other is refused. A game played only on
its own page may leave both out. A platform that ranks runs requires both, and
the ranked set's `ranking` check, `validate.sh --ranked`, says so.

`monotonic` is a promise the suite checks every tick. A score that can go
down is not monotonic, and saying it is will fail rather than round.

No run has a step limit. A session runs until `isOver()` is true or its host
stops it, and the manifest has no field that caps it. `session.hasEnding` says
whether the game ends by itself, true or false, and describes the game and
nothing more: nothing in the engine reads it, and no check holds the game to
it. The conformance checks
play each log to its end or to `CHECK_WINDOW_TICKS`, 36,000 ticks, and report
where each run stopped; a game is not refused for running the whole window.

`session.seats` is how many players take turns in one run, from 1 to 8, and
1 when it is left out. A game with more than one implements `seat()`, which
says whose turn each tick is, and `references/seats.md` covers the rest. It
leaves `capabilities.multiplayer` false: seats take turns, and nobody acts at
the same time as anyone else.

`params` are typed (`color`, `string`, `enum`, `int`, `bool`) with ranges
and defaults, and `validateParams` checks a supplied value against them before
the game sees it. The values arrive as the `config` argument to `init`, so
they are part of what a recording carries and what a replay restores. A
ranked or practice run plays the config the platform serves, which is every
declared parameter at its default, `servedConfig(manifest)`; the player never
chooses one. The conformance checks play that config too. An optional
parameter without a default is left out of it, and the game has to cope with
its absence. A required parameter without a default cannot be served at all,
so `servedConfig` refuses the manifest with `E_MANIFEST_INVALID`, naming it,
and so does `loadSubject` unless it is handed a config to play; a default its
own definition refuses, such as one outside its range, is refused the same
way.

`inputs` is everything the game records. Each entry is a name and the whole
numbers it carries, `min` to `max` inclusive, with an optional `label` a page
may show; at most 64 are declared. A press is `{ min: 0, max: 1 }`. Which key,
finger, stick or tilt drives an input is not in the manifest at all: the
game's page decides that in code, usually through `InputCapture`, and may draw
any on-screen controls it likes. The kernel refuses an undeclared name or a
value outside its range when the page pushes it, and a server's `checkInputs`
refuses a submitted log holding one, so the manifest is the whole of what a
recording may contain. `inputs.md` explains how to choose what to record, which
decides how large every recording is.

`schemaVersion` is the manifest's format, and the engine reads format 3 only.
Format 1 bound device codes under `inputs.map` and declared on-screen controls
under `inputs.controls`; format 2 declared each input by name and range, and
carried `session.maxTicks`, `session.maxWallSeconds` and `budgets.bundleBytes`.
A manifest at either is refused with a message saying what changed, and a
format 3 manifest that still carries one of the three removed fields is refused
at that field.

`assets` is every file you ship, with its sha256 and byte count. A wrong
hash, a wrong size, a declared file that is missing, or a total over
`budgets.assetBytes` fails the `budgets` check. The check reads declared files only, so an
undeclared file is not reported. `scripts/package.ts` prints this array for
you. A `path` is relative, made of letters, digits, `.`, `_`, `-` and `/`, with
no `.` or `..` segment; anything else is refused, because the checker reads it
under the bundle's directory and a host builds a URL from it.

`requiredForSim: true` makes a file a data pack, which the simulation reads
through the reader `init` receives. `load` says when it must arrive:
`"start"`, the default, before `init`, and `"demand"` when `packsNeeded()`
first names it. `load` on a file with `requiredForSim: false` is refused.
`assets.md` has the rules for reading packs.

`budgets.microsecondsPerTick` sizes the isolate's CPU allowance. Declaring
a number you do not meet fails the `performance` check; declaring a huge one
costs you at submission rather than at validation.

## Versioning

`version` is a semantic version, `MAJOR.MINOR.PATCH`, and `assertManifest`
refuses anything else. Use the parts for what they say about the rules:

- **A patch** changes how the game looks, or fixes a bug, and keeps what a
  score means. The same play scores the same.
- **A minor** changes the rules: an input, a counter, how runs rank, when a
  run ends, or anything that lets the same play score differently.
- **A major** is a game players would call different.

A platform may treat every patch of one `MAJOR.MINOR` as the same game, and
vbz does: its day's ranked runs play the newest patch of one line, and the
board mixes that line's patches. So a patch keeps the manifest fields that
decide how a run is played and ranked exactly as the line's first release
declared them - `id`, `session`, `inputs`, `counters`, `rankBy`, `tiePolicy`,
`params` and `capabilities` - and vbz refuses one that does not. Whether a fix
in the code changed what a score means is something no check can see, so
decide it before choosing the number.

A recording made against one version replays against that version, whatever
was published after it. Changing simulation behaviour without a new version is
the failure this rule exists to prevent: every score already recorded becomes
unverifiable, silently, and nothing in the replay path can tell you it
happened.
