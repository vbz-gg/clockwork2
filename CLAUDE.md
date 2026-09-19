# CLAUDE.md

Guidance for Claude Code and other coding agents working in this repository.

Read `README.md` for what the project is and `docs/plan.md` for the
specification it was built from. `docs/differences.md` says what changed from
Clockwork 1 and why.

## Commands

```bash
bun install
bun run build          # tsc -b over project references
bun run typecheck
bun run lint           # biome check .
bun run lint:fix
bun test               # unit tests, every package
bun run test:engines   # golden vectors under every installed JS engine
bun run test:e2e       # Playwright against the built demo
bun run demo           # the demo dev server - never start this yourself
bun run demo:build
```

Never start a dev server. Ask the user to run it.

## The one rule everything else serves

A simulation must be a pure function of its seed, its config and its input log,
and must produce the same bits on V8, JavaScriptCore and SpiderMonkey. Every
constraint below follows from that.

## Writing simulation code

Simulation code is anything reachable from `init()` or `tick()`.

**Allowed arithmetic:** `+ - * / %`, comparisons, `Math.sqrt`,
`Math.floor/ceil/round/trunc/abs/min/max/sign`, `Math.fround`, `Math.imul`,
`Math.clz32`, and typed-array bit manipulation. All exactly specified by
ECMAScript.

**Banned outright:** `Math.pow` and the `**` operator. Use `dmath.pow`, or
better `dmath.ipow` for an integer exponent, which is exact.

**Banned, use `dmath` instead:** `Math.sin`, `cos`, `tan`, `asin`, `acos`,
`atan`, `atan2`, `exp`, `log`, `log2`, `log10`, `cbrt`, `hypot`, and the
hyperbolics. These are implementation-defined and they really do differ:
`Math.cos(0.1)` is `0x3FEFD712F9A817C1` on JavaScriptCore and
`0x3FEFD712F9A817C0` on V8.

**Banned entirely:** `Math.random`, `Date`, `performance.now`, `setTimeout`,
`setInterval`, `requestAnimationFrame`, `crypto`, `Intl`, `toLocaleString`,
`localeCompare`, `WeakRef`, `FinalizationRegistry`, `structuredClone`,
`queueMicrotask`, `Atomics`, and `WebAssembly` outside the allow-list.
Randomness comes from `Prng`. Timing comes from the tick count and `Timer`.

**No async.** `tick()` may not be `async` and may not return a thenable. The
kernel throws if it does.

**Iteration order is part of the contract.** A `Map` or `Set` iterates in
insertion order, which is deterministic if the insertion history is. Do not
iterate a plain object's keys where order matters, and do not sort to paper over
an ordering bug.

## Working on the kernel

`@clockwork2/kernel` has **zero runtime dependencies** and its `package.json`
has no `dependencies` key at all. Anything it needs is vendored with attribution
in `NOTICE`. Test-only packages go in the workspace root's `devDependencies`.

The kernel must not import DOM types. The base `tsconfig` has no `DOM` lib for
that reason; a package that needs it adds it locally.

## Working on dmath

Every function is a transcription of the netlib fdlibm routine of the same name.
Keep the branch structure and the constant names recognisable against the C, and
keep the SunPro attribution header. A rewritten-from-scratch approximation is not
acceptable here: the value of fdlibm is that it is known correct and reviewable
against a published reference.

Never return a sentinel for an out-of-range argument. `remPio2` returning `NaN`
looks like a guard and is not one, because `NaN & 3 === 0` and the caller then
computes a plausible wrong answer from stale scratch values. Throw.

Changing any `dmath` function means regenerating its golden vectors, which is a
deliberate act. Say why in the commit body.

## Working on the host loop

`MAX_CATCHUP_TICKS` and `MAX_ACCUM_MS` are exported so tests assert against them
rather than hardcoding numbers. If the loop drops time, the recording must end
at the tick the host actually reached, or the log replays to a different state.

## Tests

- Add a test for a concrete failure mode, not a restatement of the
  implementation.
- Every conformance check in `@clockwork2/validate` needs a conforming fixture
  and a deliberately non-conformant one asserting the exact error code, so the
  documented codes cannot drift.
- Record-and-replay tests need a non-triviality guard. Assert the recording has
  inputs and the session reached a meaningful tick count, or a page that
  silently records nothing passes everything.
- `retries` is 0 in the Playwright config on purpose. For a determinism suite,
  flake is the finding. Rewrite a timing-sensitive test against the virtual
  clock rather than retrying it.

## Prose

Hyphens, never em dashes, in code, comments, docs and commit messages alike.
Plain sentences. No marketing.
