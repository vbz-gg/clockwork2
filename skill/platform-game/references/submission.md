# What the platform reads

This describes the contract a game is judged against. The submission endpoint
itself is part of the arcade platform and lives in another repository; nothing
here calls it.

## A recording

What the browser sends and the server replays:

```jsonc
{
  "format": "cw2-recording",
  "version": 1,
  "kernelVersion": "0.1.0",
  "gameId": "lane-runner",
  "gameVersion": "1.0.0",
  "manifestHash": "e4d755ee070bbde2",
  "tickHz": 60,
  "seed": "...",
  "config": { "speed": 1 },
  "inputs": [{ "tick": 12, "device": "key", "code": "left", "value": 1 }],
  "checkpoints": [{ "tick": 0, "hash": "..." }, { "tick": 60, "hash": "..." }],
  "endTick": 1650,
  "terminal": "completed",
  "counters": { "motes": 15, "ticksSurvived": 1650 }
}
```

Two things are worth noticing.

There is no per-frame delta array. A variable-step engine has to record how
much time each frame simulated; a fixed-step one has nothing to record, so a
replay is determined by the seed, the config, the inputs and `endTick`.

Checkpoints are evidence rather than input. A replay does not read them; it
produces its own and compares. Their only job is to localise a divergence to
the second it happened, which turns "this recording does not replay" into
"this recording stopped matching at tick 1380".

An input's `tick` is the tick the simulation is about to run, stamped by the
host when the input arrives. Stamping instead at the moment a frame drains the
queue would tie the stamp to the frame rate, and the same keystroke would land
on different ticks on different machines.

## What is verified

The server replays the input log against a freshly evaluated module and
compares the state it reaches with the checkpoints the client recorded, then
scores from *its own* counters. Nothing the client says about the score is
trusted, and nothing needs to be.

A recording that does not replay is refused. So is one whose `gameVersion` is
not the version it was recorded against - simulation behaviour that changed
without a version bump makes every score already recorded unverifiable, and
this is the check that catches it.

## Before submitting

```
scripts/validate.sh ./src          # all twelve checks
scripts/run-headless.ts ./src      # what a session actually looks like
scripts/package.ts ./dist --manifest=./src/manifest.ts
```

The suite is the same code the platform runs. A local pass is a convenience;
the platform's own run inside its isolate is the run that decides.
