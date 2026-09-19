# The manifest

A JSON-shaped value the platform reads *without running the game*. That is the
whole reason it exists: everything that decides how a session is run, ranked,
bounded and billed is data, so a platform can decide whether to run untrusted
code before running it.

`assertManifest` from `@clockwork2/kernel` is the schema. There is no separate
JSON Schema file in this skill, on purpose: two descriptions of one shape
drift, and the one that drifts is always the one nobody runs. The full type is
in `kernel-api.md`, which is generated from the declarations.

## The shape

```ts
{
  schemaVersion: 1,
  id: "lane-runner",          // immutable across every version of this game
  version: "1.0.0",           // strictly increasing
  name: "Lane Runner",
  kernel: { version: "0.1.0" },
  genres: ["arcade"],         // optional

  session: {
    tickHz: 60,               // 30, 60 or 120
    maxTicks: 7200,           // the hard cap; the kernel ends the run here
    maxWallSeconds: 300,
    hasEnding: true,          // false for an endless game, still capped
  },

  inputs: {
    map: {
      left: [{ code: "ArrowLeft", device: "key", label: "Left" }],
      right: [{ code: "ArrowRight", device: "key" }],
    },
    virtualControls: [        // the host draws these on a phone
      { id: "left", kind: "button", label: "Left", action: "left" },
    ],
  },

  counters: [
    { name: "motes", direction: "up", monotonic: true },
    { name: "ticksSurvived", direction: "up", monotonic: true },
  ],
  rankBy: ["motes", "ticksSurvived"],   // in order; later ones break ties
  tiePolicy: "shared",

  params: {                   // what an operator may configure
    speed: { type: "int", label: "Speed", min: 1, max: 3, default: 1 },
  },

  assets: [                   // every shipped file, hashed
    { path: "sprites.png", sha256: "...", bytes: 12345,
      requiredForSim: false, license: "CC0" },
  ],

  budgets: { bundleBytes: 2_000_000, microsecondsPerTick: 400 },
  display: { orientation: "any", minViewport: { width: 320, height: 480 } },
  capabilities: {
    deterministic: true,      // always; a manifest saying otherwise is refused
    physics: "none",
    renderer: "canvas2d",     // or "three", "pixi", "dom"
    multiplayer: false,       // always, in this release
  },
}
```

## The fields worth thinking about

**`id`** is immutable. Change it and it is a different game with a different
leaderboard. `scripts/new.ts` sets it from the directory name once, at
creation, rather than leaving it to be edited later and forgotten.

**`counters` and `rankBy`.** Objectives are `counters[name] >= threshold`,
computed by the platform, not by the game. A game that wants a new kind of
objective declares a new counter; it does not ship an operator. Everything in
`rankBy` must be declared in `counters`.

**`monotonic`** is a promise the suite checks every tick. A score that can go
down is not monotonic, and saying it is will fail rather than round.

**`session.maxTicks`** is what the platform pays to replay. It is a hard cap:
the kernel ends the run there whatever `isOver()` says. Make it the longest
session you actually intend, not the largest number you can imagine.

**`params`** are typed (`color`, `string`, `enum`, `int`, `bool`) with ranges
and defaults, and the platform validates a supplied value against them before
the game sees it. `mergeParamDefaults` fills the rest. The values arrive as
the `config` argument to `init`, so they are part of what a recording carries
and what a replay restores.

**`assets`** is every file you ship, with its sha256 and byte count.
Undeclared file, wrong hash, or declared-and-missing all fail check 7.
`scripts/package.ts` prints this array for you.

**`budgets.microsecondsPerTick`** sizes the isolate's CPU allowance. Declaring
a number you do not meet fails check 8; declaring a huge one costs you at
submission rather than at validation.

## Versioning

`version` is strictly increasing, and a recording made against one version
replays against that version. Changing simulation behaviour without bumping
the version is the failure this rule exists to prevent: every score already
recorded becomes unverifiable, silently, and nothing in the replay path can
tell you it happened.
