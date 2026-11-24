# What the platform reads

This describes the contract a game is judged against. The submission endpoint
itself is part of the platform and lives in another repository; nothing here
calls it.

## A recording

What the browser sends and the server replays:

```jsonc
{
  "format": "cw2-recording",
  "version": 3,
  "kernelVersion": "0.9.0",
  "gameId": "lane-runner",
  "gameVersion": "1.0.0",
  "manifestHash": "e4d755ee070bbde2",
  "tickHz": 60,
  "seed": "...",
  "config": { "speed": 1 },
  "inputs": [{ "tick": 12, "code": "left", "value": 1 }],
  "checkpoints": [{ "tick": 0, "hash": "..." }, { "tick": 60, "hash": "..." }],
  "endTick": 1650,
  "terminal": "completed",
  "counters": { "motes": 15, "ticksSurvived": 1650 },
  "hostStats": { "frames": 1702, "ticksRun": 1650, "mostTicksInAFrame": 2, "droppedMs": 0 }
}
```

Two things are worth noticing.

There is no per-frame delta array. A variable-step engine has to record how
much time each frame simulated; a fixed-step one has nothing to record, so a
replay is determined by the seed, the config, the inputs, `endTick` and the
data packs. The packs need no field of their own: their fingerprints are in
the manifest, and `manifestHash` covers the manifest.

`hostStats` is what the browser's loop did: how many frames, the most ticks
one frame ran, and `droppedMs`, the real time that produced no ticks, which
includes time spent waiting for a pack and not time spent waiting for
another seat's turn. A replay ignores it. A platform reads it to tell a slow
phone or a slow download from a cheat.

A run several players took turns in has one recording, whose `inputs` is the
merged log of every seat's inputs. An input carries no seat, so it replays
like any other; the replay passes `seats: seatsOf(manifest)` to the session,
and `seats.md` covers the rest.

Checkpoints are evidence rather than input. A replay does not read them; it
produces its own and compares. Their only job is to localise a divergence to
the second it happened, which turns "this recording does not replay" into
"this recording stopped matching at tick 1380".

An input's `tick` is the tick the simulation is about to run, stamped by the
host when the input arrives. Stamping instead at the moment a frame drains the
queue would tie the stamp to the frame rate, and the same keystroke would land
on different ticks on different machines.

## What is verified

This is what a platform checks of a ranked or practice run, one it served a
seed and a config for and replays on its server. A game played only on its own
page submits nothing, and none of it applies there.

The config is the platform's: every parameter the manifest declares, at its
default, as `servedConfig(manifest)` builds it. The player never picks one, and
the conformance checks play the same config.

Before anything runs, the server holds the input log to the manifest it
stored for the version with `checkInputs`: every input a declared name with a
value in its range, and no more inputs than `INPUT_BUDGET_PER_TICK` per tick
on average. A log that fails is refused without a replay.

Then it replays the input log against a freshly evaluated module, with
the packs of the version the session was issued for, as far as the recording's
own end, `Math.max(endTick, 1)`, and compares the state it reaches with the
checkpoints the client recorded, then scores from *its own* counters. No run
has a step limit, so where the run ended is the only place a replay can
stop. Nothing the client says about the score is
trusted, and nothing needs to be.

A recording that does not replay is refused. So is one whose `gameVersion` is
not the version it was recorded against - simulation behaviour that changed
without a version bump makes every score already recorded unverifiable, and
this is the check that catches it.

## Before submitting

From the game's own root, with `<guide>` the directory `SKILL.md` is in and
`./src` the directory holding the simulation's entry (`./src/sim` in a game
built with the vbz.gg SDK):

```
<guide>/scripts/validate.sh ./src --ranked # every check, the ranked set's two included
<guide>/scripts/run-headless.ts ./src      # what a session actually looks like
<guide>/scripts/package.ts ./dist --manifest=./src/manifest.ts
```

The checks are the same code a platform built on this engine runs, and a
platform may run more of its own. `--ranked` adds the two a ranked or practice
run needs: that the seed changes the game, and that the manifest says how a run
ranks. A local pass is a convenience; the
platform's own run inside its isolate is the run that decides.
