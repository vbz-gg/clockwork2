# Working in this repository

Guidance for coding agents. `README.md` says what the project is and
`docs/engine.md` explains how it works from first principles. Read the engine
doc before changing anything in `packages/engine`.

## Commands

```bash
bun install
bun run build          # tsc -b over project references
bun run typecheck
bun run lint           # biome check .
bun run lint:fix
bun test               # unit tests, the demo's fixtures and the skill
bun test skill         # the skill's own checks, on their own
bun run test:coverage  # the same tests, then the 99% floor over packages/*/src
bun run test:engines   # golden vectors under every installed JS engine
bun run test:e2e       # Playwright against the built demo
bun run test:e2e:nightly  # the seeded fuzz spec, twenty seeds
bun run gen:skill-api  # regenerate the skill's API reference after a build
bun run check:publishable  # pack the package and read what a consumer gets
bun run demo           # the demo dev server - never start this yourself
bun run demo:build
```

Never start a dev server. Ask the user to run it.

## The one rule

A simulation must be a pure function of its seed, its config and its input log,
and must produce the same bits on V8, JavaScriptCore and SpiderMonkey. Every
constraint below follows from that.

## Writing simulation code

Simulation code is anything reachable from `init()` or `tick()`.

Allowed arithmetic is what ECMAScript specifies exactly: `+ - * / %`,
comparisons, `Math.sqrt`, `Math.floor/ceil/round/trunc/abs/min/max/sign`,
`Math.fround`, `Math.imul`, `Math.clz32`, and typed-array bit manipulation.

`Math.pow` and the `**` operator are banned outright. Use `dmath.pow`, or
`dmath.ipow` for an integer exponent, which is exact.

`Math.sin`, `cos`, `tan`, `asin`, `acos`, `atan`, `atan2`, `exp`, `log`,
`log2`, `log10`, `cbrt`, `hypot` and the hyperbolics are implementation-defined
and really do differ: `Math.cos(0.1)` is `0x3FEFD712F9A817C1` on JavaScriptCore
and `0x3FEFD712F9A817C0` on V8. Use `dmath` instead.

Also unavailable: `Math.random`, `Date`, `performance.now`, `setTimeout`,
`setInterval`, `requestAnimationFrame`, `crypto`, `Intl`, `toLocaleString`,
`localeCompare`, `WeakRef`, `FinalizationRegistry`, `structuredClone`,
`queueMicrotask`, `Atomics`, and `WebAssembly` outside the allow-list.
Randomness comes from `Prng`. Timing comes from the tick count and `Timer`.

`tick()` may not be `async` and may not return a thenable. The kernel throws if
it does.

Iteration order is part of the contract. A `Map` or `Set` iterates in insertion
order, which is deterministic when the insertion history is. Do not iterate a
plain object's keys where order matters, and do not sort to paper over an
ordering bug.

## Releasing

Publishing is npm Trusted Publishing. `release.yml` grants `id-token: write`,
the npm CLI exchanges that OIDC token for a short-lived credential, and npm
signs a provenance attestation naming the commit and the workflow that built
each tarball. There is no `NPM_TOKEN` in this repository's secrets, and nothing
to rotate.

`scripts/publish.ts` calls `npm publish --access public` on `packages/engine`,
and that is the whole of it. It used to rewrite six package.json files,
substituting each `workspace:*` range for the version being published and
restoring them afterwards, because an unrewritten range reaches the registry
verbatim and that version is then uninstallable by anyone, permanently. One
package has no sibling to depend on, so the rewrite and the hazard are both
gone.

No `--provenance` flag: under trusted publishing npm produces the attestation
by default, and the flag would break the one case with no OIDC token, which is
a package's first publish. A trusted publisher cannot be configured for a
package that does not exist, so the first version of a new package is published
from a laptop and the publisher configured afterwards.

`release.yml` runs the same gate `ci.yml` does, because it is the one job whose
mistakes cannot be undone. `.versionrc.json`'s `prerelease` hook runs that gate
locally, and `bun run release` is what invokes it.

Two triggers. `workflow_dispatch` takes a `dry_run` input defaulting true; a
dry run packs and validates but never reaches the publish endpoint, so it does
not exercise the OIDC exchange. npm's documented limitations say that for a
workflow using `workflow_call` or `workflow_dispatch`, "validation checks the
calling workflow's name instead of the workflow that actually contains the
publish command", so the tag push stays as the fallback if a dispatch is
refused.

`bun run check:publishable` packs the package and reads the tarball's own
package.json: that it carries a README and a `dist`, and that nothing has crept
into `dependencies`. CI runs it on every push and the release gate runs it
again.

## One package, four halves

`packages/engine` holds what were six packages: the kernel at `src/`, the host
bridge at `src/host/`, the conformance checker at `src/validate/` and the three
renderers at `src/adapters/`. Each is a subpath export carrying its own types,
and the package is `"sideEffects": false`, so importing `/dmath` pulls nothing
else.

`@clockwork2/engine` has no runtime dependencies and its `package.json` has no
`dependencies` key at all. `pixi.js`, `three` and `typescript` are optional
peers, so nobody installs a renderer to run a simulation. Anything else it
needs is vendored with attribution in `NOTICE`; test-only packages go in the
workspace root's `devDependencies`.

**The simulation must not reach a DOM type.** When this was six packages that
fell out of the layout: the base `tsconfig` has no `DOM` lib and only the
packages needing one added it. One package has one `lib` setting and the
adapters need `DOM`, so the property is now checked rather than inherited.
`packages/engine/tsconfig.sim.json` typechecks `src/` without a DOM, excluding
the three halves that legitimately have one, and `bun run typecheck` runs it.
`scripts/lint-sim-purity.ts` is the other half, scanning built output for
banned calls and skipping `dist/host`, `dist/adapters` and `dist/validate` for
the same reason.

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

**A NaN's sign is the one thing dmath does not pin, and must not.** ECMAScript
leaves a NaN's sign and payload to the implementation, and the hardware
differs: an invalid operation yields the negative quiet NaN
`0xFFF8000000000000` on x86 and the positive `0x7FF8000000000000` on arm64.
1074 of the 1212 NaN-producing golden vectors differ between an Apple Silicon
Mac and an x86 Linux runner; the other 138 propagate a NaN that arrived as an
argument, which keeps its sign on both. So the golden comparison asserts that
a NaN result *is* a NaN and never which one, and `bun run test:engines` cannot
catch this because it runs every engine on one machine.

That is safe only because a NaN cannot reach anything that decides a score:
`hashCanonical` refuses one, counters must be whole numbers, and a recording is
JSON where `JSON.stringify(NaN)` is `null`. Keep all three. Encoding a NaN
anywhere in that path would hand an arm64 player a different checkpoint from an
x86 one and the replay would report a mismatch neither caused.

The oracle tests in `tests/dmath/oracle.test.ts` are a different matter: they
compare against the host's own `Math`, which is implementation-defined, so
their bounds say as much about the host's libm as about dmath. A bound tight
enough to pass on glibc can fail on Apple's libm without anything being wrong
here. Loosen the bound rather than the library.

## Working on the host loop

`DEFAULT_MAX_CATCHUP_TICKS` and `DEFAULT_MAX_FRAME_MS` are exported so tests
assert against them rather than hardcoding 5 and 250. If the loop drops time,
the recording must end at the tick the host actually reached, or the log
replays to a different state.

## Tests

- Add a test for a concrete failure mode. A test that restates the
  implementation passes for as long as the implementation exists and tells you
  nothing.
- Every conformance check in `@clockwork2/validate` needs a conforming fixture
  and a deliberately non-conformant one asserting the exact error code, so the
  documented codes cannot drift.
- Record-and-replay tests need a non-triviality guard. Assert the recording has
  inputs and the session reached a meaningful tick count, or a page that
  silently records nothing passes everything.
- `bun run test` passes `packages/ scripts/ demo/ skill/`. Those are path
  filters, not directories, so the trailing slash matters: without it, `demo`
  also matches `e2e/specs/07-demo-controls.spec.ts` and Bun tries to run a
  Playwright spec.
- `retries` is 0 in the Playwright config on purpose. For a determinism suite,
  flake is the finding. Rewrite a timing-sensitive test against the virtual
  clock rather than retrying it.
- `bun run test:coverage` holds `packages/*/src` at 99% of lines.
  `scripts/check-coverage.ts` measures it over `coverage/lcov.info`;
  `coverageThreshold` is absent from `bunfig.toml`, which says why. Two things
  get past a failure: a test for a concrete failure mode, or a path excluded in
  `bunfig.toml` with a written reason. A test that calls a function and asserts
  it returned is what a coverage gate invites and what the rule above forbids.
- The golden vector files are compared rather than read: `dmath-golden.tsv`
  against a recorded SHA-256 of its bytes, `probe-golden.tsv` field by field.
  `.gitattributes` pins the working tree to LF so a Windows checkout holds the
  same bytes as a Linux one. Without it `core.autocrlf` rewrote both: converting
  `probe-golden.tsv` to CRLF makes `bun run test:engines` report all 23
  non-heavy vectors as changed and exit 1, and it changes the bytes the dmath
  checksum covers. No CI run reached that comparison until the browsers moved to
  node: run 35669728895 is the first, and every vector agreed.
- `scripts/engines.ts` runs every engine as a child process fed the bundle on
  stdin, browsers included: `scripts/engines/browser-driver.mjs` drives
  Playwright under node. Bun cannot do it on Windows, where the two extra stdio
  descriptors `--remote-debugging-pipe` needs are not carried through and
  `launch()` hangs for its full 180s timeout (oven-sh/bun#27977). Node runs the
  browsers on every platform rather than on Windows alone, so CI exercises one
  path; it costs about 380ms of node startup per engine. The driver is the
  harness's only `.mjs` file, because node has to run it with no build step.

## Working on the skill

`skill/platform-game/` is prose an agent follows literally, so a stale sentence
is worse than a missing one. Everything in it that can be checked is checked by
`skill/tests/skill.test.ts`, and a change to the kernel can therefore fail it:

- `references/kernel-api.md` is generated. Never edit it. After changing a
  public type, run `bun run build && bun run gen:skill-api` in the same commit.
- `references/failure-modes.md` needs a `### E_CODE` section per entry in the
  kernel's `ERROR_CODES`, and no section for a code that does not exist. Adding
  a code means adding its section.
- The two templates' `src/sim.ts` files must stay byte-identical, and both
  templates must pass the whole conformance suite unmodified.

## Commit gates

Two hooks run on every commit. `pre-commit` lints, and checks that the skill's
failure-modes reference still has one section per error code. `commit-msg` runs
commitlint, and demands a `Docs-Updated:` trailer. Never bypass either with
`--no-verify`.

The trailer records the pass no test can make. `skill/tests/skill.test.ts`
measures the two drifts a machine can see, and nothing measures whether a
paragraph of `docs/engine.md` is still true. Writing the trailer says you
re-read the pages covering what you changed and brought them back in line.

It is demanded when the commit stages anything under `packages/`, `demo/`,
`e2e/`, `scripts/`, `skill/`, `docs/` or `.github/`, or `README.md`,
`package.json`, `tsconfig*.json` or `biome.json`. Merge, revert, fixup, squash
and `chore(release)` commits are exempt: git and commit-and-tag-version write
those messages themselves, some with no editor at all.

A value under ten characters is rejected, as is a stamp from the list in
`scripts/check-docs-updated.ts`. Say what you did, inside the 100 columns
commitlint allows a trailer line:

    Docs-Updated: regenerated kernel-api.md for the new Session option
    Docs-Updated: re-read engine.md on recording and replay; no change needed
    Docs-Updated: internal refactor, no documented behaviour or public type moved

The trailer has to be true. A new path carrying documentation joins
`BEARING_PATTERNS` in `scripts/check-docs-updated.ts` in the same change.

## Prose

Run the `humanizer` skill over anything a person reads before you commit it:
`README.md`, `docs/`, `SKILL.md` and its references, template READMEs, and
release notes. It removes the patterns that make text read as machine-written,
such as a contrast that stages a point instead of making one, a closing line
that repeats the paragraph above it, ideas arriving in threes by habit, and bold
labels on every item of a list. Rewrite the prose it flags rather than patching
the flagged phrase.

The house rules the skill does not cover:

- Hyphens, never em dashes, in code, comments, docs and commit messages alike.
- Sentence case in headings.
- Write for a reader who has not seen this engine before and does not know what
  it replaced. Explain the thing itself.
- State the measurement rather than the adjective. "35.7% of 20,000 seeded
  inputs differ between JavaScriptCore and V8" beats "the difference is
  significant", and a number nobody measured does not go in.
