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

`scripts/publish.ts` calls `npm publish --access public` on `packages/engine`.
It used to rewrite six package.json files,
substituting each `workspace:*` range for the version being published and
restoring them afterwards, because an unrewritten range reaches the registry
verbatim and that version is then uninstallable by anyone, permanently. One
package has no sibling to depend on, so the rewrite and the hazard are both
gone.

It asks the registry for the version first and exits 0 without publishing when
it is already there. Both triggers reach the same version by design, because
dispatching a publish and then pushing the matching tag is how a release gets
cut, and without the check that second run is red with no finding except that
the release already worked. The check compares the printed version and not just
the exit code: npm 10.9.7 answers a missing version with E404 and a non-zero
exit, older majors exited 0 with an empty stdout, and anything but an exact
match falls through to the publish where npm is the authority. That is the
direction it has to fail in, since it can cost an attempted publish npm refuses
and can never silently skip a release. `scripts/publish.test.ts` covers the
readings, and covers that the publish sits behind `import.meta.main` so
importing the script to test it cannot release what is on disk.

No `--provenance` flag: under trusted publishing npm produces the attestation
by default, and the flag would break the one case with no OIDC token, which is
a package's first publish. A trusted publisher cannot be configured for a
package that does not exist, so the first version of a new package is published
from a laptop and the publisher configured afterwards.

`release.yml` runs the same gate `ci.yml` does, because it is the one job whose
mistakes cannot be undone. `.versionrc.json`'s `prerelease` hook runs that gate
locally, and `bun run release` is what invokes it.

**No major releases for now.** Patch and minor only, for this repository and
for the arcade. On a 0.x version commit-and-tag-version already maps a breaking
change to a minor, so `bun run release` cannot reach 1.0.0 on its own;
`release:major` was the only script that could and it is gone.
`scripts/release-version.test.ts` holds the major at 0, so a 1.0.0 release
commit fails CI before it can be published. Lifting the policy means deleting
that test in a diff somebody reads.

The job creates the tag and the GitHub release itself, as its last step, so
cutting a release is one action and a tag can never name a commit the publish
did not come from. `gh release create` makes the tag at `--target` when it does
not exist, and a ref created with `GITHUB_TOKEN` starts no further workflow
run, so this cannot retrigger the tag trigger. It runs even when the publish
found the version already on the registry, because that is the re-run that
exists to add a tag or a release that went missing; both halves check first.
The release body is the version's own `CHANGELOG.md` section, read by
`scripts/release-notes.ts`, which throws rather than publishing a release that
says nothing about itself. That step and the bump below are why the job has
`contents: write`.

**A dispatch bumps the version, and that is what makes it a release.** It used
to publish whatever version the tree already held, expecting `bun run release`
to have been run on a laptop first; nothing said so and nothing checked.
Dispatching after #15 merged therefore found 0.4.0 on the registry, skipped,
and reported success having released nothing. The job now runs
`commit-and-tag-version` itself, with `--scripts.prerelease=""` because the
steps above already ran that gate and the hook would additionally run
`test:engines`, which drives browsers this job does not install, and with
`--skip.tag` because the last step makes the tag. Three things follow, and
`scripts/release-version.test.ts` holds all of them:

- The checkout needs `fetch-depth: 0`. commit-and-tag-version works out the
  changelog from the commits since the most recent tag, and measured on a
  clone missing `v0.4.0` it compared from `v0.3.2` and re-listed a release's
  worth of commits that had already shipped.
- The build has to run **again** after the bump. The bump rewrites
  `KERNEL_VERSION` in `packages/engine/src`, and `dist` is what the tarball
  carries, so without it the published package reports the previous version
  from inside itself while its package.json says otherwise.
- The tag names the bump commit, not the one the job checked out.

`release_as` is a named `patch` or `minor` rather than whatever the commits
imply, because on a 0.x version commit-and-tag-version maps everything but a
breaking change to a patch and can decide on no change at all. There is no
`major` option, which is the same policy the test below holds.

**A dispatch on a tree with nothing new refuses.** Naming the bump means the
job will cut a version whether or not anything changed, and that is how 0.6.0
happened: a dispatch landed on a commit that had been released a moment
earlier, bumped it again, and published a version whose changelog section is
blank. The step now compares `git describe --tags --abbrev=0` against HEAD and
exits 1 when `git rev-list` between them is empty. A repository with no tag at
all falls through, because then everything is unreleased.

`scripts/release-notes.ts` is the second guard and it was not working. Its doc
comment said an empty body would publish a release that says nothing about
itself, and its check only fired when the section was *missing*: for 0.6.0 it
found the heading, returned the empty string between it and the next, and
`gh release create` announced a blank release. It throws on an empty section
now, which is the last place to notice before a version is announced.

Two triggers. `workflow_dispatch` takes a `dry_run` input defaulting **false**,
so a dispatch publishes unless the box is ticked; the tag trigger publishes
with no box at all, so a dispatch needing one to do the same thing was the odd
one out. The tag trigger does not bump, because a tag already names a version
the tree carries. A dry run packs and validates but never reaches the publish endpoint,
so it does not exercise the OIDC exchange. npm's documented limitations say that for a
workflow using `workflow_call` or `workflow_dispatch`, "validation checks the
calling workflow's name instead of the workflow that actually contains the
publish command". Run 35699600341 measured that a dispatch does validate:
0.3.0 published from one and npm signed its provenance. The tag trigger stays
for a tag pushed by hand.

**A release tells the repositories that pin this engine.** The last step
dispatches an `engine-released` event to each of them with the version it
published, so a release reaches them in seconds rather than whenever their own
daily check next runs. Today that is game-base and the arcade, told one at a
time so that one refusing the token does not stop the other. GITHUB_TOKEN is scoped to this repository and cannot
dispatch to another, so that step reads `ENGINE_RELEASED_TOKEN`, an
organisation secret. The dispatch needs Contents: write on each repository it
tells, and those repositories open their update pull request with the same
secret, which needs Pull requests: write. GitHub's table of fine-grained token
permissions lists both, so the token carries both on those repositories and
nothing else. With Contents alone the dispatch arrives and the pull request is
refused. It is the only long-lived credential here. Contents: write can also
push to any unprotected branch of those repositories, which is more than a
pull request needs and much less than the npm token trusted publishing
removed.

The step is best-effort, and `scripts/release-version.test.ts` holds it that
way. By the time it runs the version is published, tagged and announced, so a
missing or expired token must not turn a release that worked into a red run.
Every repository it tells also polls the registry daily, which is what makes a
failure there a delay rather than a miss - and the poll is also what catches a
version published from a laptop, where no workflow ran at all.

`bun run check:publishable` packs the package and reads what a consumer would
get: that the tarball carries a README and a `dist`, that nothing has crept
into `dependencies`, and that plain node can import every subpath the exports
map names. CI runs it on every push and the release gate runs it again.

`.versionrc.json`'s `prerelease` hook runs the gate before the version is
bumped, so it never sees the tree a release actually ships. Anything holding
the version literal therefore has to be in `bumpFiles`. `KERNEL_VERSION` is,
and so is the skill's generated `references/kernel-api.md`, which embeds it.
Without that second entry the bump wrote 0.2.0 into the kernel and left the
reference at 0.1.0; the tag build regenerated the reference, found the
difference and exited 1. That failed every release rather than an occasional
one, and it is why v0.2.0 was tagged and never published.
`scripts/release-version.test.ts` looks for the next file to grow the literal
rather than for this one.

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

**Every relative import carries `.js`.** `tsc` emits a relative specifier
exactly as the source wrote it, and node ESM has no extension resolution, so
`from "./bits"` builds, typechecks and passes the whole suite under bun and
then fails on a consumer's first `import` with ERR_MODULE_NOT_FOUND. Every
version from 0.1.0 to 0.7.0 shipped that way, and nothing in a build, a lint or
a test could see it, because bun and every bundler resolve it. A directory
import needs the whole thing: `./hash/index.js`, never `./hash`.

`bun run check:publishable` is what catches the next one. It imports every
subpath of the packed tarball with plain node, so what is measured is what a
consumer gets rather than what this repository can resolve. A subpath whose
optional peer is missing here is reported as unchecked rather than as a fault -
`pixi.js` is not installed in this checkout, so `/adapter-pixi` cannot be
imported on any machine that has not asked for pixi.

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

`dmath.copysign` was the one way around all three. It reads the sign bit of its
second argument and returns a finite number, so `copysign(5, inf - inf)` was
`-5` on x86 and `5` on arm64 and the hash took both. It now refuses a NaN in
either argument with `E_ARG_INVALID`, which fdlibm's C does not do; the reason
is in its doc comment and in `docs/engine.md` under arithmetic. `scalbn` is the
only internal caller and is unaffected, because it returns at its `k === 0x7ff`
branch before it reaches a copysign call. Anything added to dmath that reads a
sign bit or a payload rather than a value needs the same look.

**The oracle tests compare against `Math`, and that is not a mistake even
though a simulation may never call it.** The point is not that `Math` is
available to a game. It is that the host's libm is the only independent
implementation of these functions within reach. The golden vectors compare
dmath against its own last run, so a file regenerated from a broken build
blesses the break. The identities compare it against mathematics, which is
stronger and much looser: `exp(log(x)) = x` is checked to 4096 ulp, because the
round trip amplifies. Between the two sits a band that only the host covers.
Scaling `dmath.log` by `1 + e` puts numbers on it: at `e = 3e-15`, about 28
ulp, the identities catch it; at `1e-15`, about 10 ulp, only the host
comparison does; at `3e-16`, 2 ulp, nothing catches it and nothing should. That
middle band is the size of a mistyped low-order digit in an fdlibm constant,
which is the defect these tests are for.

What it costs is that the bound has to sit near the host's own accuracy to
cover that band, so a host with a looser libm fails a test that is about us.
`tan` is the worked example. It failed at 2 ulp on macOS arm64, reaching 3 at
`351.07445158064365`; against a 60-digit reference dmath was 0.48 ulp from
exact, which is the correctly rounded double, and JavaScriptCore was 2.52 ulp
out. The bound moved to 8 and the library did not move at all.

When a host comparison fails, measure before loosening: find which side is
wrong. If it is ours, fix dmath. If it is the host's, loosen the bound **and**
pin the input with an exact assertion, so the looser bound cannot hide a later
regression at the one point the host is known to be wrong about.

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
