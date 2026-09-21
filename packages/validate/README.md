# @clockwork2/validate

The conformance suite for [Clockwork 2](https://github.com/vbz-gg/clockwork2)
games: twelve checks with stable error codes, run the same way on a developer's
machine and by whatever platform accepts the game.

```bash
bunx --package @clockwork2/validate clockwork2-validate ./src
bunx --package @clockwork2/validate clockwork2-validate ./src --only=determinism
```

Determinism, headless, bound, banned APIs, no async, restore, budgets,
performance, counters, replay, manifest and render smoke. Every failure carries
a code such as `E_RESTORE_MISMATCH@1380`, so a message can be rewritten without
breaking anything that routes on the result.

A local pass is a convenience. The platform's own run, inside its isolate, is
the run that decides.

MIT.
