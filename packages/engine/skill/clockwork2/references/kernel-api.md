# Kernel API

**Generated from the built type declarations. Do not edit.**
The clockwork2 repository regenerates it with `bun run gen:skill-api`, and
the guide's own tests there fail when this file and the declarations
disagree.

Anything not listed here is not part of the contract. Where this reference
and `@clockwork2/engine/validate` disagree, the validator is right.

## `@clockwork2/engine`

The contract, the loop, and everything a simulation may call.

### Accumulator

```ts
export declare class Accumulator {
    readonly stepMs: number;
    constructor(options: AccumulatorOptions);
    /**
     * Adds a frame's elapsed time and says how many whole ticks to run.
     *
     * The caller runs that many steps and then reads `alpha` for the renderer.
     */
    frame(elapsedMs: number): number;
    /** How far between the last tick and the next, in [0, 1). */
    get alpha(): number;
    get stats(): {
        readonly frames: number;
        readonly droppedMs: number;
        readonly mostTicksInAFrame: number;
    };
    reset(): void;
}
```

### ClockworkError

The one error type. Catching code switches on `code`, never on the message, and never on a substring of it, and recognises one with `isClockworkError`, never `instanceof`, because a page can hold two copies of the engine.

```ts
export declare class ClockworkError extends Error {
    readonly code: ErrorCode;
    readonly tick: number | undefined;
    readonly detail: string | undefined;
    constructor(code: ErrorCode, options?: ClockworkErrorOptions);
    /** The short form a log line or a CLI prints: `E_RESTORE_MISMATCH@1800`. */
    get tag(): string;
}
```

### CounterTracker

Watches a running session's counters.

```ts
export declare class CounterTracker {
    constructor(declarations: readonly CounterDeclaration[]);
    get names(): readonly string[];
    /**
     * Checks one reading. Call it with the counters and whether the run has
     * ended; both are what the platform will eventually be paid on.
     */
    check(counters: Counters, isOver: boolean, tick: number): void;
    reset(): void;
}
```

### Hash64

Incremental so that a large snapshot can be hashed without first building a large string.

```ts
export declare class Hash64 {
    update(text: string): this;
    /** Feeds a double by its bit pattern, so -0 and 0 stay different. */
    updateNumber(value: number): this;
    /** 16 lowercase hex digits. Calling it does not end the hasher. */
    digest(): string;
    reset(): this;
}
```

### LiveInputQueue

Collects inputs between frames and stamps them at the moment the simulation reaches a tick. The log it builds is the recording.

```ts
export declare class LiveInputQueue implements InputSource, InputSink {
    /** What a summed amount owed past its range, carried into later ticks. */
    constructor(inputs: Inputs);
    push(pushed: PendingInput): void;
    addPoller(poll: () => void): () => void;
    /** Reads every polled device. The host calls this before a frame's ticks. */
    poll(): void;
    onPause(release: () => void): () => void;
    /**
     * The session paused: whatever is held is released, and nothing more is
     * taken until `resume`. A press while paused would land on the tick the
     * session resumes at, which is not when the player made it.
     */
    pause(): void;
    onResume(listener: () => void): () => void;
    resume(): void;
    take(tick: number): readonly InputEvent[];
    /**
     * Holds each summed amount to its declared range. The excess is carried
     * into later ticks, up to one range's width, and anything past that is
     * dropped: a flick faster than the game declared it could record is
     * recorded at the most it can carry, never refused.
     */
    /** The whole log so far, which is what a recording carries. */
    recorded(): readonly InputEvent[];
    get pendingCount(): number;
    reset(): void;
}
```

### NodeSet

Keeps one node per item, by id.

```ts
export declare class NodeSet<TItem, TNode> {
    constructor(handlers: {
        readonly id: (item: TItem) => string;
        readonly create: (item: TItem) => TNode;
        readonly update: (node: TNode, item: TItem) => void;
        readonly destroy: (node: TNode, id: string) => void;
    });
    sync(items: Iterable<TItem>): void;
    get(id: string): TNode | undefined;
    get size(): number;
    clear(): void;
}
```

### PackSet

Packs the kernel has checked against a manifest, ready to share.

```ts
export declare class PackSet {
    /**
     * Checks every pack given and keeps the kernel's own copies.
     *
     * @throws E_PACK_UNDECLARED for a path the manifest does not declare as a
     *   pack, E_PACK_TOO_LARGE and E_PACK_HASH_MISMATCH for bytes that are not
     *   the ones declared.
     */
    static verify(assets: readonly AssetDeclaration[] | undefined, packs: Iterable<readonly [string, PackBytes]>): PackSet;
    /**
     * Holds packs to check when a session first needs each one, for a replay
     * that has every pack in memory and should pay the hash, a pass over every
     * byte, only for those the run reads.
     *
     * A start pack is checked when a session is built, because `init` may read
     * it. A demand pack is checked before the first tick after `packsNeeded()`
     * names it, so wrong bytes are `E_PACK_HASH_MISMATCH` at that tick, and a
     * pack the run never names is never hashed at all. Each is checked once,
     * however many sessions share the set, and the kernel's copy is kept from
     * then on. Everything happens inside the session's own synchronous steps,
     * so `runSession` replays with it as it does with any set.
     *
     * A lazy set is for a replay that holds every byte up front, and a
     * session treats its packs as held from the start, checked or not:
     * `packsMissing()` never names one, `holds()` is true for it, and
     * `deliver()` ignores bytes for it. So nothing can replace a pack that
     * turns out wrong, and a wrong byte ends the session at the first tick
     * that needs that pack, where a host that fetches its packs would hold the
     * loop and try again. `GameHost` is given bytes and a loader for that
     * reason, never a set.
     *
     * The set holds the bytes it was given until a session needs them, so the
     * caller must not change them before then. What is checked is what is
     * read either way: the check copies the bytes and reads only the copy.
     *
     * @throws E_PACK_UNDECLARED for a path the manifest does not declare as a
     *   pack, now; a wrong size or hash only when a session needs that pack.
     */
    static lazy(assets: readonly AssetDeclaration[] | undefined, packs: Iterable<readonly [string, PackBytes]>): PackSet;
    /** The packs in this set, in the order they were given. */
    get paths(): readonly string[];
    /** Whether the set holds the pack, checked or not yet. */
    has(path: string): boolean;
}
```

### Prng

```ts
export declare class Prng {
    constructor(seed: string);
    /** What this stream was seeded from. Sub-streams derive their own from it. */
    get seed(): string;
    /** A double in [0, 1). */
    random(): number;
    /** A uniform 32-bit unsigned integer. */
    randomUint32(): number;
    /** An integer in [min, max], both ends included. */
    randomInt(min: number, max: number): number;
    /** A double in [min, max). */
    randomFloat(min: number, max: number): number;
    /** True with probability `threshold`. */
    randomBoolean(threshold?: number): boolean;
    /** One item, uniformly. Throws on an empty list rather than returning undefined. */
    randomChoice<T>(items: readonly T[]): T;
    /** Fisher-Yates, in place, drawing exactly `items.length - 1` times. */
    shuffle<T>(items: T[]): T[];
    /**
     * A labelled sub-stream, created on first use and memoised. Drawing from it
     * never moves this stream, and drawing from this stream never moves it.
     */
    stream(label: string): Prng;
    /** The whole tree, as plain data. Put this in your snapshot. */
    exportState(): PrngState;
    /**
     * Restores the whole tree. A sub-stream named in the state is created if this
     * instance has not reached it yet, which is what makes restoring into a fresh
     * module work.
     */
    importState(state: PrngState): void;
    /** Back to the start of the stream, sub-streams included. */
    reset(): void;
}
```

### RecordedInputSource

Replays a recorded log. Built once, then walked with a cursor, so a session costs one pass over the log however many ticks it runs.

```ts
export declare class RecordedInputSource implements InputSource {
    constructor(events: readonly InputEvent[], options?: {
        readonly endTick?: number;
    });
    /** Skips everything before `tick`, for a replay that starts part way in. */
    seek(tick: number): void;
    take(tick: number): readonly InputEvent[];
    /** How far through the log the cursor has walked. */
    get consumed(): number;
    get length(): number;
}
```

### Session

One run of one game.

```ts
export declare class Session<TView = unknown, TConfig = PlainValue> {
    /** The packs this game may read, or null when no assets were given. */
    /** Start packs: readable in init, restore and every tick. */
    /**
     * The set given before the session, possibly shared with other sessions,
     * or null. A pack in it may not have been checked yet; `checkedPack`
     * checks it the first time any session needs it.
     */
    /** Demand packs delivered to this session alone. */
    /** Demand packs `packsNeeded()` has named since they were last released. */
    /** What `packsNeeded()` said for the next tick. */
    /** Which of the game's calls is running, while one that may read is. */
    /**
     * What the game reads its packs through. `init` receives it; the same
     * object serves the whole session.
     */
    readonly packs: PackReader;
    constructor(options: SessionOptions<TView, TConfig>);
    /**
     * The packs a set holds, after making sure they were checked against the
     * same entries this session declares. A set checked against another version
     * of the manifest would otherwise hand this one bytes it never declared.
     */
    /** Whether the set this session was given holds the pack, checked or not. */
    /** A pack from the set, checked first if no session has needed it yet. */
    /** The bytes behind a read, after every rule about reading has held. */
    /** Runs one of the game's calls that may read packs. */
    /** Asks the game what the next tick will read, once per tick. */
    /** Every name the game hands the kernel must be a declared pack. */
    /**
     * The packs the next tick needs that this session does not have yet. A
     * host holds its loop while this is not empty and delivers what it names.
     */
    packsMissing(): readonly string[];
    /** Whether this session has the pack's bytes now, given or delivered. */
    holds(path: string): boolean;
    /**
     * Hands a demand pack to this session. The kernel checks it and keeps its
     * own copy, so the caller may reuse or transfer the buffer afterwards. A
     * pack the session already has is left as it is.
     *
     * @throws E_PACK_UNDECLARED, E_PACK_TOO_LARGE or E_PACK_HASH_MISMATCH
     */
    deliver(path: string, bytes: PackBytes): void;
    get tick(): number;
    get running(): boolean;
    get checkpoints(): readonly Checkpoint[];
    /**
     * Runs exactly one tick.
     *
     * @returns whether the session is still running afterwards
     */
    step(): boolean;
    /**
     * Makes what `packsNeeded()` named readable for the tick about to run, and
     * releases what it stopped naming.
     *
     * A demand pack this session was given through `deliver` is dropped once it
     * has been named and then is not, so a long run through many areas does not
     * hold every one of them. If the game names it again, `packsMissing` says
     * so and the host delivers it again; what the game can read never depends
     * on whether that happened quickly. A pack prefetched and not yet named is
     * kept, and so is everything in a shared set. A pack from the set that no
     * session has needed before is checked here, before the tick that may read
     * it, so wrong bytes fail at that tick, and before anything here changes,
     * so a pack that fails leaves this session's packs as they were.
     */
    /** Ends the session early, for a player who walked away or a host error. */
    abandon(reason?: TerminalReason): void;
    result(): SessionResult;
}
```

### Timer

```ts
export declare class Timer {
    /** The tick most recently run. Starts at 0 and is advanced by the loop. */
    get tick(): number;
    /**
     * Registers a handler. Call these during `init`, before any scheduling, so
     * that a restore into a fresh module finds every name it needs.
     */
    define(name: string, handler: TimerHandler): void;
    /** Runs `name` once, `ticks` from now. */
    after(name: string, ticks: number): number;
    /** Runs `name` every `ticks`, starting `ticks` from now. */
    every(name: string, ticks: number): number;
    clear(id: number): boolean;
    pause(id: number): void;
    resume(id: number): void;
    get size(): number;
    has(id: number): boolean;
    /**
     * Moves to the next tick and runs whatever is due.
     *
     * Due entries run in `(targetTick, id)` order, so two timers landing on the
     * same tick always run in the order they were created. A handler that
     * schedules another timer does not make it run in this pass, because a
     * delay of zero is treated as one tick.
     */
    advance(): void;
    /** Everything except the handlers, which the game owns. */
    exportState(): TimerState;
    /** Rebinds a state onto the handlers already declared. */
    importState(state: TimerState): void;
    /** Drops every scheduled entry, keeping the declared handlers. */
    reset(): void;
}
```

### assertManifest

The throwing form.

```ts
export declare function assertManifest(value: unknown): Manifest;
```

### checkInputs

Checks a run's whole log against the manifest it was played under: every input is one the manifest declares, with a value in its range; no tick holds more than `MAX_INPUTS_PER_TICK`; and the run holds no more than `INPUT_BUDGET_PER_TICK x (endTick + 1)`.

```ts
export declare function checkInputs(events: readonly InputEvent[], inputs: Inputs, options: {
    readonly endTick: number;
}): void;
```

### checkInputSpan

The same check for a slice of a log: the inputs after tick `afterTick` through `throughTick`, held to the budget for the ticks they cover. A server runs it on each chunk as it arrives, so a run cannot store more than its budget before it is submitted. `afterTick` is -1 for the first.

```ts
export declare function checkInputSpan(events: readonly InputEvent[], inputs: Inputs, span: {
    readonly afterTick: number;
    readonly throughTick: number;
}): void;
```

### compareByRank

Orders two results. Negative means `a` ranks higher.

```ts
export declare function compareByRank(a: Counters, b: Counters, rankBy: RankBy, declarations: readonly CounterDeclaration[]): number;
```

### compareToRecording

Compares a replay against what a recording claims.

```ts
export declare function compareToRecording(recording: Recording, replayed: {
    readonly endTick: number;
    readonly counters: Counters;
    readonly checkpoints: readonly Checkpoint[];
}): RecordingComparison;
```

### decodeRecording

Parses and checks a recording.

```ts
export declare function decodeRecording(source: string | unknown): Recording;
```

### encodeCanonical

Encodes to a string. Useful for tests and for reporting a difference.

```ts
export declare function encodeCanonical(value: PlainValue): string;
```

### encodeRecording

```ts
export declare function encodeRecording(recording: Recording): string;
```

### fail

```ts
export declare function fail(code: ErrorCode, options?: ClockworkErrorOptions): never;
```

### fromBits

```ts
export declare function fromBits(bits: bigint): number;
```

### fromBitsHex

```ts
export declare function fromBitsHex(hex: string): number;
```

### hash64

One-shot form.

```ts
export declare function hash64(text: string): string;
```

### hashCanonical

Encodes straight into a hasher, so nothing large is built in memory.

```ts
export declare function hashCanonical(value: PlainValue): string;
```

### installShims

```ts
export declare function installShims(): void;
```

### instantiate

Normalises the two allowed shapes of a default export.

```ts
export declare function instantiate<TView, TConfig>(source: GameModuleSource<TView, TConfig>): GameModule<TView, TConfig>;
```

### isClockworkError

```ts
export declare function isClockworkError(value: unknown): value is ClockworkError;
```

### isStartPack

True for a pack that must arrive before `init`. Absent means start.

```ts
export declare function isStartPack(asset: AssetDeclaration): boolean;
```

### lerp

Between the last tick's value and this one, at `alpha`.

```ts
export declare function lerp(previous: number, current: number, alpha: number): number;
```

### lerpAngle

The same, the short way round a circle, for an angle in radians.

```ts
export declare function lerpAngle(previous: number, current: number, alpha: number): number;
```

### logicPacks

The assets a simulation reads, by path, in declaration order.

```ts
export declare function logicPacks(assets: readonly AssetDeclaration[] | undefined): ReadonlyMap<string, AssetDeclaration>;
```

### meetsThreshold

The only operator there is. An objective is a row in a manifest, not code.

```ts
export declare function meetsThreshold(counters: Counters, name: string, threshold: number): boolean;
```

### mergeParamDefaults

Fills in defaults. A parameter with neither a value nor a default is left out rather than set to undefined, so the result stays canonically encodable and a snapshot holding it can be hashed.

```ts
export declare function mergeParamDefaults(schema: ParamSchema, values: ParamValues | null | undefined): ParamValues;
```

### nextDown

```ts
export declare function nextDown(x: number): number;
```

### nextUp

The next representable double towards +Infinity. Used by tests.

```ts
export declare function nextUp(x: number): number;
```

### outsideDeclaration

Why `value` is not one `declaration` allows, or null when it is.

```ts
export declare function outsideDeclaration(declaration: InputDeclaration, value: number): string | null;
```

### prefetchPaths

The pack paths a prefetch effect names, or null for any other effect. The names are not checked here; the session checks them as the tick ends.

```ts
export declare function prefetchPaths(effect: Effect): readonly unknown[] | null;
```

### quantiseAxis

Turns a stick or trigger reading in [-1, 1] into an integer.

```ts
export declare function quantiseAxis(value: number, options?: AxisOptions): number;
```

### quantisePoint

Turns a pointer coordinate into simulation units.

```ts
export declare function quantisePoint(value: number, fromSize: number, toUnits: number): number;
```

### runSession

Drives a session to its end, or to `maxTicks`. This is what a validator runs, with `maxTicks` at `Math.max(endTick, 1)` of the recording it replays.

```ts
export declare function runSession<TView = unknown, TConfig = PlainValue>(options: RunSessionOptions<TView, TConfig>): SessionResult;
```

### servedConfig

The config a platform serves a ranked or practice run: every parameter the manifest declares, at its default. A player never supplies one, because a replay plays the recording's config, so a config the player chose would be replayed and agree with itself. The conformance checks play this too, so what they check is what a session plays.

```ts
export declare function servedConfig(manifest: Manifest): ParamValues;
```

### sha256Hex

The digest of `bytes`, as 64 lowercase hex digits.

```ts
export declare function sha256Hex(bytes: Uint8Array, lengthOverride?: number): string;
```

### shimsInstalled

```ts
export declare function shimsInstalled(): boolean;
```

### toBits

The whole 64-bit pattern, for hashing, golden vectors and equality.

```ts
export declare function toBits(x: number): bigint;
```

### toBitsHex

The 16-hex-digit form used in vectors and in every divergence report.

```ts
export declare function toBitsHex(x: number): string;
```

### ulpDistance

Distance in representable doubles. Returns -1n when only one side is NaN, so a caller can tell "both NaN" from "one NaN".

```ts
export declare function ulpDistance(a: number, b: number): bigint;
```

### uninstallShims

```ts
export declare function uninstallShims(): void;
```

### unshimmableApis

Names the traps could not be installed on in this environment, because the property is not configurable. Reported rather than hidden: the static scan is what covers them.

```ts
export declare function unshimmableApis(): readonly string[];
```

### validateInputLog

Checks an input log's shape.

```ts
export declare function validateInputLog(events: readonly InputEvent[], options?: {
    readonly endTick?: number;
}): void;
```

### validateManifest

Every problem with a manifest, in document order.

```ts
export declare function validateManifest(value: unknown): Issue[];
```

### validateParams

Checks a set of supplied values against a schema.

```ts
export declare function validateParams(schema: ParamSchema, values: ParamValues | null | undefined): Issue[];
```

### withShims

Runs `body` with the traps in place and takes them down afterwards, whatever happens. Nested calls are counted, so a caller that already installed them keeps them.

```ts
export declare function withShims<T>(body: () => T): T;
```

### DEFAULT_MAX_CATCHUP_TICKS

```ts
DEFAULT_MAX_CATCHUP_TICKS = 5
```

### DEFAULT_MAX_FRAME_MS

```ts
DEFAULT_MAX_FRAME_MS = 250
```

### ERROR_CODES

Every failure this kernel and its conformance suite can report, as a stable code. The codes are the contract: the agent skill's failure-modes reference is keyed on them, the submission pipeline routes on them, and a developer reads them in a log. Renaming one is a breaking change.

```ts
ERROR_CODES: {
    /** tick() returned a thenable. The loop is synchronous by construction. */
    readonly E_ASYNC_TICK: "tick() returned a thenable; the simulation must be synchronous";
    /** A shimmed global was touched during init() or tick(). */
    readonly E_BANNED_API: "a banned global was used inside the simulation";
    /** Prng was constructed without a seed. There is no unseeded path. */
    readonly E_SEED_REQUIRED: "a seed is required; there is no unseeded PRNG";
    /** An argument fell outside the range a dmath routine can reduce exactly. */
    readonly E_DMATH_RANGE: "argument outside the exactly reducible range";
    /** A snapshot held a value the canonical encoder refuses to encode. */
    readonly E_CANONICAL_UNSUPPORTED: "snapshot holds a value with no canonical encoding (NaN, Infinity, undefined, a function or a class instance)";
    /** A counter declared monotone moved the wrong way. */
    readonly E_COUNTER_REVERSED: "a monotone counter moved the wrong way";
    /** A counter was not a finite integer inside 53 bits. */
    readonly E_COUNTER_RANGE: "a counter is not a finite integer within 53 bits";
    /** isOver() returned false after returning true. */
    readonly E_OVER_FLIPPED: "isOver() went back to false";
    /** A recording carried a format or version this kernel does not read. */
    readonly E_RECORDING_VERSION: "recording format or version is not readable here";
    /** A recording failed its structural checks. */
    readonly E_RECORDING_MALFORMED: "recording is malformed";
    /** An input log was not sorted by tick. */
    readonly E_INPUT_UNSORTED: "input log is not sorted by tick";
    /**
     * An input log entry no recording can hold: a tick or a value that is not a
     * whole number, a `-0`, no name, or a tick outside the run or the span.
     */
    readonly E_INPUT_RANGE: "input value is out of range";
    /** An input the manifest does not declare, or a value outside its declared range. */
    readonly E_INPUT_UNDECLARED: "an input is not one the manifest declares, or is out of its range";
    /** A log holding more inputs than the budget allows (`checkInputs`). */
    readonly E_INPUT_BUDGET: "a log holds more inputs than any player makes";
    /** A manifest failed validation. */
    readonly E_MANIFEST_INVALID: "manifest is invalid";
    /** An argument the caller controls was outside the range the API accepts. */
    readonly E_ARG_INVALID: "an argument is outside the range this API accepts";
    /** The host cannot supply something the engine needs to run correctly. */
    readonly E_ENV_UNSUPPORTED: "this environment cannot run the engine correctly";
    /** A pack was named that the manifest does not declare as one. */
    readonly E_PACK_UNDECLARED: "a pack was named that the manifest does not declare with requiredForSim";
    /** The game read a pack outside the steps it asked for it. */
    readonly E_PACK_NOT_REQUESTED: "the simulation read a pack it had not asked for at this step";
    /** A pack the session needs has not been handed over. */
    readonly E_PACK_NOT_DELIVERED: "a pack the session needs was not delivered";
    /** A pack's bytes are not the ones its manifest entry declares. */
    readonly E_PACK_HASH_MISMATCH: "a pack's bytes do not match the sha256 and size its manifest declares";
    /** A pack is longer than its manifest entry declares. */
    readonly E_PACK_TOO_LARGE: "a pack is larger than its manifest declares";
    /** Two runs of the same seed, config and inputs reached different states. */
    readonly E_DETERMINISM_DIVERGED: "two runs of the same session reached different states";
    /** The module threw when loaded or stepped with no browser present. */
    readonly E_HEADLESS_THREW: "module threw in a headless run";
    /** The static scan found a banned API in the simulation's import graph. */
    readonly E_LINT_BANNED: "a banned API appears in the simulation's import graph";
    /** await, async or .then appears in the simulation, or a microtask changed state. */
    readonly E_ASYNC_DETECTED: "asynchronous work in the simulation";
    /** restore-then-continue did not equal continue. */
    readonly E_RESTORE_MISMATCH: "restore-then-continue diverged from continue";
    /** A declared file is missing or wrong, or the assets exceed their budget. */
    readonly E_BUDGET_EXCEEDED: "a declared asset is missing, misdeclared or over the asset budget";
    /** The simulation was slower per tick than the performance budget allows. */
    readonly E_PERF_BUDGET: "per-tick cost above the budget";
    /** A recording did not replay to the state it was recorded from. */
    readonly E_REPLAY_MISMATCH: "replay did not reproduce the recorded state";
    /** The manifest failed its JSON Schema. */
    readonly E_MANIFEST_SCHEMA: "manifest failed schema validation";
    /** The bundle touched a global the sandbox forbids. */
    readonly E_GLOBALS_TOUCHED: "the bundle touched a forbidden global";
    /** The render bundle failed its smoke check. */
    readonly E_RENDER_SMOKE: "render smoke check failed";
    /** A check threw while running, which is itself a failure of the subject. */
    readonly E_CHECK_THREW: "a conformance check threw while running";
    /** The subject could not be loaded: no entry file, or no module to run. */
    readonly E_SUBJECT_LOAD: "the subject could not be loaded";
    /** Two seeds passed through the same states on every log the seed check plays. */
    readonly E_SEED_IGNORED: "two seeds passed through the same states on every log; the seed decides nothing";
    /** The manifest says nothing about how a run ranks. */
    readonly E_RANK_UNDECLARED: "the manifest declares no rankBy and tiePolicy, which a ranked run needs";
}
```

### INPUT_BUDGET_PER_TICK

How many inputs a log may hold per tick it covers, on average. A server holds a whole run to `INPUT_BUDGET_PER_TICK x (endTick + 1)` and each chunk to the same rate over the ticks it covers, so a recording cannot grow without bound however long the run.

```ts
INPUT_BUDGET_PER_TICK = 16
```

### KERNEL_VERSION

The major of this constant is pinned by a game's manifest. A bundle built against a different kernel major is refused rather than run.

```ts
KERNEL_VERSION = "0.9.0"
```

### KEY_CODES

Every `KeyboardEvent.code` value a manifest may bind: the UI Events KeyboardEvent code Values Recommendation, without `Unidentified`.

```ts
KEY_CODES: readonly string[]
```

### MANIFEST_FORMAT

The format this kernel reads. A manifest at any other is refused.

```ts
MANIFEST_FORMAT = 3
```

### MAX_INPUTS_PER_TICK

The most inputs any single tick may hold. A safety net under the budget below: an honest burst stays far under it.

```ts
MAX_INPUTS_PER_TICK = 256
```

### MAX_JSON_PACK_BYTES

The most bytes `json()` will decode: 2^29 - 24, which is V8's longest string. A UTF-8 byte is at least one UTF-16 code unit, so a pack this size or smaller always fits. Larger ones decode on JavaScriptCore and SpiderMonkey and throw on V8, and a pack that worked in one browser and not another is a pack nobody can ship.

```ts
MAX_JSON_PACK_BYTES = 536870888
```

### MAX_JSON_SIGNIFICANT_DIGITS

ECMAScript fixes the value of a number with at most 20 significant digits and lets each engine choose between two neighbours above that (RoundMVResult, which `JSON.parse` uses too). So `json()` refuses a longer number rather than let engines read the same pack differently.

```ts
MAX_JSON_SIGNIFICANT_DIGITS = 20
```

### PREFETCH_EFFECT

The effect type a game emits to say it will need a pack soon. Its `data` is a pack path or an array of them. The kernel checks every name, so an undeclared one fails the same tick in every host; the host starts loading and otherwise ignores it. Effects never reach state, so a hint that arrives late or not at all changes nothing but whether the loop has to wait.

```ts
PREFETCH_EFFECT = "prefetch"
```

### RECORDING_FORMAT

```ts
RECORDING_FORMAT = "cw2-recording"
```

### RECORDING_VERSION

Bumped whenever a field changes meaning. `decodeRecording` checks it, which game-base's envelope did not: it wrote a version and read it nowhere, while changing codec twice underneath.

```ts
RECORDING_VERSION = 3
```

### TERMINAL_REASONS

How a session ended. Written by the kernel, never by the game.

```ts
TERMINAL_REASONS: readonly ["completed", "died", "timeout", "abandoned", "error"]
```

### TIE_POLICIES

```ts
TIE_POLICIES: readonly ["shared", "earliest", "none"]
```

### AccumulatorOptions

The accumulator a browser host runs.

```ts
export interface AccumulatorOptions {
    readonly tickHz: number;
    /** The most ticks one frame may run before the rest of the debt is dropped. */
    readonly maxCatchUpTicks?: number;
    /** The most real time one frame may contribute. */
    readonly maxFrameMs?: number;
}
```

### AxisOptions

```ts
export interface AxisOptions {
    /** Readings inside this fraction of full deflection read as zero. */
    readonly deadzone?: number;
    /** Integer units at full deflection. */
    readonly scale?: number;
}
```

### GameModule

What a game implements.

```ts
export interface GameModule<TView = unknown, TConfig = PlainValue> {
    /** Validated by the platform without running the game. */
    readonly manifest: unknown;
    /**
     * Deterministic setup. No I/O, no clock, no network.
     *
     * `packs` reads the data packs the manifest declares. Start packs can be
     * read here, in `restore` and in every tick; a demand pack only in a tick
     * that `packsNeeded()` named it for. Keep the reader: a `restore` that
     * calls `init` again has to hand it back.
     */
    init(seed: string, config: TConfig, packs: PackReader): void;
    /** Advance exactly one tick. The only writer of simulation state. */
    tick(inputs: readonly InputEvent[]): void;
    /**
     * What the renderer reads. May be a live reference when the renderer shares
     * a thread with the simulation, so a renderer must treat it as read-only.
     * It must be structured-cloneable, because in worker mode it is cloned.
     */
    view(): TView;
    /** A plain-data copy, for hashing, restore and submission. */
    snapshot(): Snapshot;
    /**
     * Rebuild state from a snapshot. Restoring at tick N and continuing must
     * reach the same state as never having stopped, PRNG position included.
     */
    restore(snapshot: Snapshot): void;
    /** The declared counters, as integers. */
    score(): Counters;
    /** True once, and never false again. */
    isOver(): boolean;
    /** Cues from the last tick. The host drains this; calling it clears it. */
    effects(): readonly Effect[];
    /**
     * The demand packs the next tick will read, as a pure function of state.
     *
     * The kernel calls it once after `init`, once after `restore`, and once
     * after every tick, and the answer decides what the next tick may read. A
     * host that lacks one of the named packs holds the loop until it arrives,
     * so the step that reads it is the same step everywhere. Naming a start
     * pack is allowed and changes nothing. Leave it out when the game has no
     * demand packs.
     */
    packsNeeded?(): readonly string[];
}
```

### InputSink

Where the device helpers put what they see: a live queue, or a worker's.

```ts
export interface InputSink {
    push(input: PendingInput): void;
    /**
     * Runs `poll` once per frame, before the frame's ticks, for a device the
     * browser does not send events for: a gamepad is read, not heard. Returns
     * a function that stops it.
     */
    addPoller(poll: () => void): () => void;
    /**
     * Runs `release` when the session pauses, before the queue stops taking
     * input, so whatever is held is let go in the log. Returns a function that
     * stops it.
     */
    onPause(release: () => void): () => void;
    /**
     * Runs `listener` when the session resumes, so a capture that ignored the
     * devices while paused starts hearing them again. Returns a function that
     * stops it.
     */
    onResume(listener: () => void): () => void;
}
```

### InputSource

Where a running simulation gets its inputs, live or recorded.

```ts
export interface InputSource {
    /** Everything that applies to `tick`, in order. */
    take(tick: number): readonly InputEvent[];
    /**
     * Moves past everything before `tick`, for a session resumed from a
     * snapshot. A live source has nothing to skip and may leave this out.
     */
    seek?(tick: number): void;
}
```

### PackReader

What a game reads its packs through. `init` receives it.

```ts
export interface PackReader {
    /**
     * The pack's bytes, as a fresh copy on every call. Writing into it changes
     * nothing anywhere else, so a server that shares one copy of a pack between
     * many replays cannot have one replay corrupt the next.
     */
    open(path: string): Uint8Array;
    /**
     * The pack decoded as UTF-8 JSON, parsed afresh on every call. A leading
     * byte order mark is dropped. Invalid UTF-8, invalid JSON, a number with
     * more than 20 significant digits and a pack over `MAX_JSON_PACK_BYTES`
     * are refused with `E_ARG_INVALID`.
     */
    json(path: string): PlainValue;
}
```

### PendingInput

A device event the host has seen but not yet stamped.

```ts
export interface PendingInput {
    readonly code: string;
    readonly value: number;
    readonly merge?: MergeRule;
}
```

### Presentation

What a renderer implements. It reads and never writes. `TContainer` is generic so the kernel stays free of DOM types; an adapter narrows it.

```ts
export interface Presentation<TView = unknown, TContainer = unknown> {
    mount(container: TContainer, context: PresentationContext): void;
    /**
     * @param view the current simulation view
     * @param previousView the view one tick earlier, or null on the first frame
     * @param alpha how far between them this frame sits, in [0, 1)
     * @param dtMs real milliseconds since the previous frame, for effects that
     *   are allowed to be frame-dependent because nothing reads them back
     */
    render(view: TView, previousView: TView | null, alpha: number, dtMs: number): void;
    unmount(): void;
}
```

### PresentationContext

What the host hands a presentation when it mounts.

```ts
export interface PresentationContext {
    /**
     * Randomness for the renderer. Never seeded from the session, so that
     * consuming it cannot move the simulation's stream, and a purely visual
     * flourish cannot change the result.
     */
    readonly random: () => number;
    readonly assets: ReadonlyMap<string, ArrayBuffer | string>;
    readonly devicePixelRatio: number;
    readonly theme: string;
}
```

### SessionOptions

```ts
export interface SessionOptions<TView = unknown, TConfig = PlainValue> {
    readonly module: GameModule<TView, TConfig>;
    readonly seed: string;
    readonly config: TConfig;
    readonly inputs: InputSource;
    /**
     * Where the session stops, with terminal `timeout`, if the game has not
     * ended it first. A replay passes `Math.max(endTick, 1)` from the recording
     * it replays, so it stops where the run it replays stopped. Left out, the
     * session runs until the game ends it or `abandon` is called.
     */
    readonly maxTicks?: number;
    /** Ticks between state hashes. 0 turns checkpointing off. */
    readonly checkpointEvery?: number;
    /** Declared counters, checked as the run goes. */
    readonly counters?: readonly CounterDeclaration[];
    /** Set false only in a test that is measuring the cost of the traps. */
    readonly shims?: boolean;
    readonly onCheckpoint?: (checkpoint: Checkpoint) => void;
    readonly onEffects?: (effects: readonly Effect[], tick: number) => void;
    readonly onTick?: (tick: number) => void;
    /**
     * The manifest's assets. The ones marked `requiredForSim` are the packs this
     * game may read. Left out, the session has no packs and any read is
     * refused with `E_PACK_NOT_DELIVERED`.
     */
    readonly assets?: readonly AssetDeclaration[];
    /**
     * Packs in hand before the session, from `PackSet.verify`, which checked
     * them all, or `PackSet.lazy`, which checks each when a session first
     * needs it. Every start pack must be here, because `init` runs inside the
     * constructor and may read one. Demand packs may be here too, or arrive
     * later through `deliver`.
     */
    readonly packs?: PackSet;
    /**
     * Continues from a snapshot instead of starting fresh.
     *
     * `init` still runs first, so that whatever the game declares there -
     * timer handlers above all - exists before the snapshot is bound onto it.
     * Restoring into a module that never ran `init` is how a restored timer
     * finds no handler to call.
     */
    readonly resumeFrom?: {
        readonly snapshot: Snapshot;
        readonly tick: number;
    };
}
```

### SessionResult

```ts
export interface SessionResult {
    /** How many ticks ran. */
    readonly endTick: number;
    readonly terminal: TerminalReason;
    readonly counters: Counters;
    readonly checkpoints: readonly Checkpoint[];
    readonly snapshot: Snapshot;
}
```

### AssetDeclaration

```ts
export type AssetDeclaration = {
    readonly path: string;
    readonly sha256: string;
    readonly bytes: number;
    /**
     * True when the simulation reads it, so the validator fetches it. A texture
     * is false; a level layout the simulation walks is true.
     */
    readonly requiredForSim: boolean;
    /**
     * When a pack the simulation reads must arrive. Only meaningful with
     * `requiredForSim: true`, and refused otherwise.
     *
     * `"start"`, the default, arrives before `init` and can be read from `init`,
     * `restore` and every tick. `"demand"` arrives when the game's
     * `packsNeeded()` names it, and can be read only in the ticks that follow
     * such a call.
     */
    readonly load?: "start" | "demand";
    readonly license: string;
    readonly generator?: string;
};
```

### Checkpoint

```ts
export type Checkpoint = {
    readonly tick: number;
    readonly hash: string;
};
```

### CounterDeclaration

```ts
export type CounterDeclaration = {
    readonly name: string;
    readonly direction: CounterDirection;
    /** True when the counter may never move against its direction. */
    readonly monotonic: boolean;
    readonly label?: string;
};
```

### CounterDirection

Which way is better. A monotone counter may only move that way.

```ts
export type CounterDirection = "up" | "down";
```

### Counters

Declared counters. Every value is an integer.

```ts
export type Counters = Readonly<Record<string, number>>;
```

### Effect

A cue for the host: a sound to play, a rumble, a camera shake. Produced by the last tick and drained by the host.

```ts
export type Effect = {
    readonly type: string;
    readonly data?: PlainValue;
};
```

### ErrorCode

```ts
export type ErrorCode = keyof typeof ERROR_CODES;
```

### GameModuleSource

A bundle's default export. A factory is allowed because one process running many sessions needs many instances; the platform still evaluates the module afresh per session, since a fresh instance does not reset a module-level counter.

```ts
export type GameModuleSource<TView = unknown, TConfig = PlainValue> = GameModule<TView, TConfig> | (() => GameModule<TView, TConfig>);
```

### InputDeclaration

One input a game records: a name, and the whole numbers it can carry.

```ts
export type InputDeclaration = {
    readonly min: number;
    readonly max: number;
    /** Shown to the player on a controls card. */
    readonly label?: string;
};
```

### InputEvent

One input, stamped with the tick it applies to.

```ts
export type InputEvent = {
    readonly tick: number;
    /** The name of an input the manifest declares. */
    readonly code: string;
    readonly value: number;
};
```

### Inputs

Every input a game records, by name. Only these are recorded, and a server refuses a log holding anything else, so each game decides what its recording holds.

```ts
export type Inputs = {
    readonly [name: string]: InputDeclaration;
};
```

### Manifest

```ts
export type Manifest = {
    /**
     * The manifest's format. 3 since no run has a step limit: format 3 has no
     * `session.maxTicks`, `session.maxWallSeconds` or `budgets.bundleBytes`,
     * and `rankBy` and `tiePolicy` are optional. Format 2 was the first to
     * declare the game's own inputs rather than binding devices.
     */
    readonly schemaVersion: typeof MANIFEST_FORMAT;
    /** Immutable across every version of the game. */
    readonly id: string;
    /** Strictly increasing. */
    readonly version: string;
    readonly name: string;
    readonly kernel: {
        readonly version: string;
    };
    readonly genres?: readonly string[];
    readonly session: Session;
    readonly inputs: Inputs;
    readonly counters: readonly CounterDeclaration[];
    readonly params?: ParamSchema;
    readonly assets?: readonly AssetDeclaration[];
    readonly budgets?: Budgets;
    readonly display?: Display;
    readonly capabilities: Capabilities;
} & Ranking;
```

### MergeRule

How a pending input joins others of the same name before the tick it lands on. `"latest"` keeps only the last value, for a reading that holds (a stick, tilt, a pointer's position): what the tick needs is where it ended up. `"sum"` adds them up, for an amount (wheel notches, mouse movement), and drops a sum of nothing. Left out, every input is kept in order, which a press needs.

```ts
export type MergeRule = "latest" | "sum";
```

### PackBytes

Bytes a host hands over. The kernel copies them before it checks them.

```ts
export type PackBytes = ArrayBuffer | Uint8Array;
```

### ParamSchema

```ts
export type ParamSchema = {
    readonly [name: string]: ParamDefinition;
};
```

### ParamValues

```ts
export type ParamValues = {
    readonly [name: string]: string | number | boolean;
};
```

### PlainValue

A value with an exact canonical encoding. Anything else is refused.

```ts
export type PlainValue = string | number | boolean | null | readonly PlainValue[] | {
    readonly [key: string]: PlainValue;
};
```

### PrngState

Plain data, so it drops straight into a snapshot.

```ts
export type PrngState = {
    readonly s: AleaState;
    /**
     * The seed, on the root only.
     *
     * It is here because a sub-stream created *after* a snapshot was taken is
     * seeded from its parent's seed, so restoring the generator positions is not
     * enough: a restored game that later reaches for a stream it had not used
     * yet would seed it from whatever the restoring module was constructed with
     * and draw a different sequence from then on. That failure is invisible in
     * the snapshot itself, which compares equal, and shows up minutes later as a
     * replay that does not match.
     */
    readonly seed?: string;
    /** Sub-streams by label, only those that have been created. */
    readonly k?: {
        readonly [label: string]: PrngState;
    };
};
```

### RankBy

Ranking: earlier entries decide first.

```ts
export type RankBy = readonly string[];
```

### Ranking

How a ranked run is ordered, declared together or not at all.

```ts
export type Ranking = {
    readonly rankBy: readonly string[];
    readonly tiePolicy: TiePolicy;
} | {
    readonly rankBy?: never;
    readonly tiePolicy?: never;
};
```

### Recording

```ts
export type Recording = {
    readonly format: typeof RECORDING_FORMAT;
    readonly version: number;
    /** The kernel that produced it. A different major cannot be replayed here. */
    readonly kernelVersion: string;
    readonly gameId: string;
    readonly gameVersion: string;
    /** Hash of the manifest the session ran under. */
    readonly manifestHash: string;
    readonly tickHz: TickRate;
    readonly seed: string;
    readonly config: PlainValue;
    /** Sorted by tick. */
    readonly inputs: readonly InputEvent[];
    /** One per second of play, plus tick 0 and the last tick. */
    readonly checkpoints: readonly Checkpoint[];
    readonly endTick: number;
    readonly terminal: TerminalReason;
    /** What the client claims. The server compares this against its own replay. */
    readonly counters: Counters;
    /**
     * The host loop's own measurements, or null for a version 1 recording.
     *
     * Nullable rather than optional, because `Recording` has to remain a
     * `PlainValue` and an optional property does not satisfy that index
     * signature. Null says "this recording predates the field" rather than
     * "there were no frames".
     */
    readonly hostStats: HostStats | null;
};
```

### RunSessionOptions

What `runSession` takes: a session's options with `maxTicks` required. A loop with nothing to stop it would run for ever on a game that never ends, and a replay always knows where the run it replays stopped.

```ts
export type RunSessionOptions<TView = unknown, TConfig = PlainValue> = SessionOptions<TView, TConfig> & {
    readonly maxTicks: number;
};
```

### Snapshot

A plain-data copy of simulation state: hashable, storable, restorable.

```ts
export type Snapshot = {
    readonly [key: string]: PlainValue;
};
```

### TerminalReason

```ts
export type TerminalReason = (typeof TERMINAL_REASONS)[number];
```

### TickRate

```ts
export type TickRate = (typeof TICK_RATES)[number];
```

### TiePolicy

```ts
export type TiePolicy = (typeof TIE_POLICIES)[number];
```

### TimerHandler

```ts
export type TimerHandler = () => void;
```

### TimerState

```ts
export type TimerState = {
    readonly tick: number;
    readonly nextId: number;
    readonly entries: readonly TimerEntryState[];
};
```

### dmath

Every member is listed under `@clockwork2/engine/dmath` below.

### fixed

#### fixed.abs

```ts
export declare function abs(value: Fixed): Fixed;
```

#### fixed.add

```ts
export declare function add(a: Fixed, b: Fixed): Fixed;
```

#### fixed.ceil

```ts
export declare function ceil(value: Fixed): Fixed;
```

#### fixed.clamp

```ts
export declare function clamp(value: Fixed, low: Fixed, high: Fixed): Fixed;
```

#### fixed.div

```ts
export declare function div(a: Fixed, b: Fixed): Fixed;
```

#### fixed.floor

```ts
export declare function floor(value: Fixed): Fixed;
```

#### fixed.fromInt

```ts
export declare function fromInt(value: number): Fixed;
```

#### fixed.fromNumber

```ts
export declare function fromNumber(value: number): Fixed;
```

#### fixed.lerp

Linear interpolation, with t in [0, FIXED_ONE].

```ts
export declare function lerp(a: Fixed, b: Fixed, t: Fixed): Fixed;
```

#### fixed.max

```ts
export declare function max(a: Fixed, b: Fixed): Fixed;
```

#### fixed.min

```ts
export declare function min(a: Fixed, b: Fixed): Fixed;
```

#### fixed.mul

Multiplication, rounded to nearest.

```ts
export declare function mul(a: Fixed, b: Fixed): Fixed;
```

#### fixed.round

```ts
export declare function round(value: Fixed): Fixed;
```

#### fixed.sqrt

Square root by Newton's method on integers. Exact and engine-independent.

```ts
export declare function sqrt(value: Fixed): Fixed;
```

#### fixed.sub

```ts
export declare function sub(a: Fixed, b: Fixed): Fixed;
```

#### fixed.toInt

Truncates towards zero, the way an integer cast does.

```ts
export declare function toInt(value: Fixed): number;
```

#### fixed.toNumber

```ts
export declare function toNumber(value: Fixed): number;
```

#### fixed.FIXED_MAX

```ts
FIXED_MAX: Fixed
```

#### fixed.FIXED_MIN

```ts
FIXED_MIN: Fixed
```

#### fixed.FIXED_ONE

```ts
FIXED_ONE: Fixed
```

#### fixed.FIXED_SHIFT

```ts
FIXED_SHIFT = 16
```

#### fixed.Fixed

The type is a plain number; the brand is a note to the reader.

```ts
export type Fixed = number;
```

## `@clockwork2/engine/dmath`

Deterministic transcendentals. Every one of these replaces a `Math` function that ECMAScript leaves implementation-defined.

### acos

```ts
export declare function acos(x: number): number;
```

### asin

```ts
export declare function asin(x: number): number;
```

### atan

atan, atan2, asin and acos, from fdlibm s_atan.c, e_atan2.c, e_asin.c and e_acos.c. See NOTICE.

```ts
export declare function atan(xIn: number): number;
```

### atan2

```ts
export declare function atan2(y: number, x: number): number;
```

### copysign

`x` with the sign of `y`. Refuses a NaN in either argument with `E_ARG_INVALID`.

```ts
export declare function copysign(x: number, y: number): number;
```

### cos

```ts
export declare function cos(x: number): number;
```

### exp

exp, from fdlibm e_exp.c. See NOTICE.

```ts
export declare function exp(x: number): number;
```

### exp2i

Exposed so a caller can build a power of two without reaching for pow.

```ts
export declare function exp2i(k: number): number;
```

### f32add

```ts
export declare function f32add(a: number, b: number): number;
```

### f32div

```ts
export declare function f32div(a: number, b: number): number;
```

### f32FromBits

```ts
export declare function f32FromBits(bits: number): number;
```

### f32mul

```ts
export declare function f32mul(a: number, b: number): number;
```

### f32sub

```ts
export declare function f32sub(a: number, b: number): number;
```

### f32ToBits

```ts
export declare function f32ToBits(x: number): number;
```

### hypot

sqrt(x*x + y*y), scaled so neither square overflows or underflows.

```ts
export declare function hypot(x: number, y: number): number;
```

### ipow

x raised to a whole-number power, by squaring.

```ts
export declare function ipow(x: number, n: number): number;
```

### isNegative

True when x is negative, including -0. Cheaper and clearer than comparing.

```ts
export declare function isNegative(x: number): boolean;
```

### log

log, log2 and log10, from fdlibm e_log.c. See NOTICE.

```ts
export declare function log(x: number): number;
```

### log10

```ts
export declare function log10(x: number): number;
```

### log2

```ts
export declare function log2(x: number): number;
```

### pow

pow and ipow, from fdlibm e_pow.c. See NOTICE.

```ts
export declare function pow(x: number, y: number): number;
```

### scalbn

x * 2^n, exactly. Transcribed from fdlibm s_scalbn.c, which handles subnormal input and output by scaling in and out rather than by repeated multiplication, so no intermediate rounding creeps in.

```ts
export declare function scalbn(x: number, n: number): number;
```

### sign

-1, 0 or 1, with the sign of a zero preserved. `Math.sign` is exact.

```ts
export declare function sign(x: number): number;
```

### sin

sin, cos and tan, from fdlibm s_sin.c, s_cos.c and s_tan.c. See NOTICE.

```ts
export declare function sin(x: number): number;
```

### tan

```ts
export declare function tan(x: number): number;
```

### wrapAngle

Brings an angle into [-pi, pi).

```ts
export declare function wrapAngle(x: number): number;
```

### abs

```ts
abs: (x: number) => number
```

### ceil

```ts
ceil: (x: number) => number
```

### clz32

```ts
clz32: (x: number) => number
```

### f32

Rounds to the nearest float32.

```ts
f32: (x: number) => number
```

### floor

```ts
floor: (x: number) => number
```

### fround

```ts
fround: (x: number) => number
```

### imul

```ts
imul: (x: number, y: number) => number
```

### max

```ts
max: (...values: number[]) => number
```

### min

```ts
min: (...values: number[]) => number
```

### PI

```ts
PI = 3.141592653589793
```

### PI_2

```ts
PI_2 = 1.5707963267948966
```

### PI_4

```ts
PI_4 = 0.7853981633974483
```

### round

```ts
round: (x: number) => number
```

### sqrt

Re-exported so that a simulation can import every number it needs from one place. `Math.sqrt` has been exactly specified since August 2024 and is safe to call directly; this is here for uniformity at the call site, not because the built-in is a problem.

```ts
sqrt: (x: number) => number
```

### trunc

```ts
trunc: (x: number) => number
```

### TWO_PI

```ts
TWO_PI = 6.283185307179586
```

## `@clockwork2/engine/testing`

Input logs and comparison helpers, shared with the validator.

### ReferenceGame

```ts
export declare class ReferenceGame implements GameModule<ReferenceView, ReferenceConfig> {
    readonly manifest: Manifest;
    init(seed: string, config: ReferenceConfig): void;
    tick(inputs: readonly InputEvent[]): void;
    view(): ReferenceView;
    snapshot(): Snapshot;
    restore(snapshot: Snapshot): void;
    score(): Counters;
    isOver(): boolean;
    effects(): readonly Effect[];
}
```

### botInputs

Someone working the game's own inputs: a press held for a while and let go, and every other input moved across its range now and then, edges included. Representative rather than good, so a game is checked against something that keeps playing.

```ts
export declare function botInputs(manifest: Manifest, seed: string, endTick: number): readonly InputEvent[];
```

### botLog

A plausible player: holds a direction for a while, thrusts in bursts.

```ts
export declare function botLog(seed: string, endTick: number): readonly InputEvent[];
```

### chaosInputs

Random values of the game's own inputs at random ticks, a quarter of them at the edge of their range. Not a player; a fuzzer.

```ts
export declare function chaosInputs(manifest: Manifest, seed: string, endTick: number): readonly InputEvent[];
```

### chaosLog

Random presses and releases at random ticks. Not a player; a fuzzer.

```ts
export declare function chaosLog(seed: string, endTick: number): readonly InputEvent[];
```

### compareCheckpoints

Finds the first checkpoint where two runs part company.

```ts
export declare function compareCheckpoints(expected: readonly Checkpoint[], actual: readonly Checkpoint[]): Divergence;
```

### compareCounters

```ts
export declare function compareCounters(expected: Counters, actual: Counters): readonly string[];
```

### compareResults

Everything two session results can disagree about, in one report.

```ts
export declare function compareResults(expected: SessionResult, actual: SessionResult): Divergence;
```

### compareSnapshots

One line per field that differs, one level deep.

```ts
export declare function compareSnapshots(expected: Snapshot, actual: Snapshot): readonly string[];
```

### createReferenceGame

The default export shape a real bundle uses.

```ts
export declare function createReferenceGame(): ReferenceGame;
```

### idleLog

Nothing is ever pressed.

```ts
export declare function idleLog(): readonly InputEvent[];
```

### packReaderFor

```ts
export declare function packReaderFor(packs?: ReadonlyMap<string, Uint8Array>): PackReader;
```

### standardLogs

The three, by name, for a runner that sweeps all of them.

```ts
export declare function standardLogs(seed: string, endTick: number): ReadonlyMap<string, readonly InputEvent[]>;
```

### ACTIONS

```ts
ACTIONS: readonly ["left", "right", "thrust"]
```

### REFERENCE_CONFIG

```ts
REFERENCE_CONFIG: ReferenceConfig
```

### REFERENCE_COUNTERS

```ts
REFERENCE_COUNTERS: readonly CounterDeclaration[]
```

### REFERENCE_MANIFEST

```ts
REFERENCE_MANIFEST: Manifest
```

### Divergence

```ts
export interface Divergence {
    /** The first tick where the two runs differ, or null when they do not. */
    readonly tick: number | null;
    readonly differences: readonly string[];
}
```

### ReferenceConfig

```ts
export type ReferenceConfig = {
    readonly arenaWidth: number;
    readonly arenaHeight: number;
    readonly spawnEveryTicks: number;
    readonly targetScore: number;
    readonly lives: number;
    readonly hitCooldownTicks: number;
    /** The run ends here even if nobody touches a key. */
    readonly timeLimitTicks: number;
};
```

### ReferenceView

```ts
export type ReferenceView = {
    readonly shipX: number;
    readonly shipY: number;
    readonly heading: number;
    readonly collectibles: readonly {
        readonly x: number;
        readonly y: number;
    }[];
    readonly score: number;
    readonly lives: number;
};
```

## `@clockwork2/engine/host`

Running a game in a page: the accumulator loop, pack loading, and the optional device helpers that turn keys, pointers, the wheel, gamepads and tilt into a game's own inputs. Not reachable from a simulation.

### AudioSink

A sink for `{ type: "sound", data: "<name>" }` effects.

```ts
export declare class AudioSink {
    constructor(options: AudioSinkOptions);
    /** Hand this straight to the host's onEffects. */
    readonly handle: (effects: readonly Effect[]) => void;
    play(name: string): void;
    /** Browsers hold the context suspended until a gesture inside the frame. */
    unlock(): Promise<void>;
    close(): void;
}
```

### GameHost

```ts
export declare class GameHost<TView = unknown, TContainer = unknown, TConfig = PlainValue> {
    /** Present only for a live session; a replay reads its recorded source. */
    readonly live: LiveInputQueue | null;
    /** Real time that passed while the loop held for a pack. */
    /** Frames that ran no tick because the loop was holding from their start. */
    /** The config given, or the served one: what the session and its recording carry. */
    constructor(options: GameHostOptions<TView, TContainer, TConfig>);
    get tick(): number;
    /**
     * The manifest this session runs under.
     *
     * Public because the frame bridge needs its hash for the `ready` message,
     * and reaching into the options object to get it was a cast that would
     * survive the field being renamed.
     */
    get manifest(): Manifest;
    get seed(): string;
    get status(): HostState;
    /**
     * What the loop did. `droppedMs` counts the time it held for a pack as well
     * as the time it dropped, because both are real time that produced no
     * ticks, and a platform deciding whether a run was slow needs to see both.
     */
    get stats(): LoopStats;
    /** The packs the loop is holding for right now. */
    get waitingFor(): readonly string[];
    /** How far between the last tick and the next, for the renderer. */
    get alpha(): number;
    setSpeed(speed: number): void;
    start(): void;
    pause(): void;
    resume(): void;
    /** Ends the session without finishing it, for a player who walked away. */
    stop(reason?: TerminalReason): void;
    /**
     * Holds the loop for packs the next tick needs.
     *
     * The time is not fed to the accumulator, so nothing is banked and no burst
     * of ticks follows the arrival; it is counted in `droppedMs` instead.
     */
    /**
     * Runs one tick by hand, for a test that wants no frame pacing at all.
     *
     * It cannot wait for a download, so it throws `E_PACK_NOT_DELIVERED` at a
     * tick whose demand pack is not here. A test stepping a game with demand
     * packs preloads them all, with `loadPacks(manifest, loader, "all")`.
     */
    stepOnce(): boolean;
    result(): SessionResult;
    counters(): Counters;
    snapshot(): Snapshot;
    /** What the renderer sees. Read it; writing to it is not a supported idea. */
    view(): TView;
    /**
     * The recording this session produced, ready to submit or replay.
     *
     * A replayed session has no live queue, so it reports the log it was given
     * rather than an empty one; `recordingFrom` is how a caller passes it.
     */
    recording(inputs?: readonly InputEvent[]): Recording;
    destroy(): void;
}
```

### InputCapture

Listens for device events and records them as the game's inputs.

```ts
export declare class InputCapture {
    /** Which sources hold each press name down. */
    /** pointerId to the slot it is down in. */
    /** Between the queue's pause and its resume, when nothing is heard. */
    /** With `gamepads.any`, the controller that plays. */
    /** A lock asked for and not yet granted or refused. */
    /** The last value recorded per level name, so a repeat is not an input. */
    /** Fractions of an amount not yet recorded. */
    /** Gamepads by index, with the id last seen there. */
    constructor(options: InputCaptureOptions);
    attach(): void;
    /**
     * Listens for one event, and acts on it only while not paused and, under
     * `scripted: "ignore"`, only when the browser rather than a script made it.
     */
    /** One notice per request, however many ways the browser says no. */
    /** The lowest free slot, taken only when a pointer goes down. */
    /** Presses and releases each mouse or pen button whose bit changed. */
    /** Where the pointer is across the element, in each name's own range. */
    /** Adds `amount` to what is owed, and records the whole part of it. */
    /** A controller went away: its buttons come up and its sticks centre. */
    /** A value that holds until it changes: a repeat is not an input. */
    /** A press is down while any of its sources holds it. */
    /**
     * Releases everything held, so a session that loses focus or pauses does
     * not stick: keys and buttons come up, sticks centre, and the pointers'
     * slots are freed. A controller button still physically down is pressed
     * again by the next poll, which is right: it is down.
     */
    releaseAll(): void;
    detach(): void;
}
```

### ManualScheduler

A scheduler a test drives by hand.

```ts
export declare class ManualScheduler implements Scheduler {
    now(): number;
    request(callback: (now: number) => void): number;
    cancel(handle: number): void;
    /** Moves the clock forward and runs the frames that were waiting. */
    advance(ms: number): void;
    /** Runs `count` frames of `ms` each. */
    run(count: number, ms: number): void;
    get pendingCount(): number;
}
```

### browserScheduler

The real one: `requestAnimationFrame` over `performance.now`.

```ts
export declare function browserScheduler(): Scheduler;
```

### checkCapture

Every problem with `mapping` against `manifest`, or an empty list. Pure, so a page, `vbz check` and `vbz dev` can run it before a run is started: a mapping mistake found after a ranked run was issued has already spent it.

```ts
export declare function checkCapture(mapping: CaptureMapping, manifest: Manifest): string[];
```

### currentScreenAngle

`screenAngleOf` for this page.

```ts
export declare function currentScreenAngle(): number | undefined;
```

### fetchPackLoader

Fetches packs over HTTP.

```ts
export declare function fetchPackLoader(options: FetchPackLoaderOptions): PackLoader;
```

### loadPacks

Loads the packs a session needs before it starts: the start packs, or every pack the manifest declares when a host would rather never wait.

```ts
export declare function loadPacks(manifest: Manifest, loader: PackLoader, which?: "start" | "all"): Promise<Map<string, PackBytes>>;
```

### memoryPackLoader

Serves packs from memory: a server's cache, or a test.

```ts
export declare function memoryPackLoader(packs: ReadonlyMap<string, PackBytes>): PackLoader;
```

### motionEnvironment

```ts
export declare function motionEnvironment(): MotionEnvironment;
```

### requestMotion

Asks for tilt. Call it as the first thing a click handler does, before any `await`: anything awaited first moves the request out of the tap, and iOS then refuses without asking.

```ts
export declare function requestMotion(options?: {
    readonly wait?: number;
    readonly environment?: MotionEnvironment;
}): Promise<MotionAccess>;
```

### screenAngleOf

How far the screen is turned, in the frame `deviceorientation` readings are measured in, which is the device's natural orientation.

```ts
export declare function screenAngleOf(scope: ScreenAngleSource): number | undefined;
```

### screenRotation

The screen's rotation from the device's natural orientation, in degrees, as the tilt maths needs it, or undefined when the browser cannot say.

```ts
export declare function screenRotation(angle: number | undefined): 0 | 90 | 180 | 270 | undefined;
```

### DEVICE_NOTICES

Something about a device the page should tell the player, which does not stop the run: a player on keys or touch plays on whatever a controller does.

```ts
DEVICE_NOTICES: {
    /** The page forbids gamepads, so none is read. */
    readonly GAMEPAD_BLOCKED: "E_GAMEPAD_BLOCKED";
    /** A controller reports no standard layout, so its buttons may sit elsewhere. */
    readonly GAMEPAD_UNMAPPED: "E_GAMEPAD_UNMAPPED";
    /** The browser refused to lock the mouse to the game. */
    readonly POINTER_LOCK_REFUSED: "E_POINTER_LOCK_REFUSED";
}
```

### GAMEPAD_AXES

```ts
GAMEPAD_AXES = 16
```

### GAMEPAD_BUTTONS

```ts
GAMEPAD_BUTTONS = 32
```

### GAMEPAD_SLOTS

The four controllers a browser reports at most.

```ts
GAMEPAD_SLOTS = 4
```

### MOTION_REFUSALS

Why tilt is not available. Each is something to tell the player.

```ts
MOTION_REFUSALS: {
    /** The page is not https (or localhost), and browsers give sensors only to a secure page. */
    readonly INSECURE: "E_MOTION_INSECURE";
    /** This browser has no orientation events, or cannot say which way the screen is turned. */
    readonly UNSUPPORTED: "E_MOTION_UNSUPPORTED";
    /** The player said no, or was asked outside a tap. */
    readonly DENIED: "E_MOTION_DENIED";
    /** The page's own permissions policy forbids the sensors. */
    readonly BLOCKED: "E_MOTION_BLOCKED";
    /** Nothing arrived: a laptop or a desktop with no tilt sensor. */
    readonly NO_SENSOR: "E_MOTION_NO_SENSOR";
}
```

### MOTION_WAIT_MS

How long a grant waits for a first reading before it calls the device sensorless.

```ts
MOTION_WAIT_MS = 1000
```

### POINTER_BUTTONS

`PointerEvent.button` values: main, middle, right, back, forward.

```ts
POINTER_BUTTONS = 5
```

### POINTER_SLOTS

Fingers, pens and the mouse, each with a small slot number.

```ts
POINTER_SLOTS = 10
```

### AudioSinkOptions

```ts
export interface AudioSinkOptions {
    /** Recipes by effect name, each filling one mono buffer. */
    readonly sounds: Readonly<Record<string, {
        seconds: number;
        recipe: SoundRecipe;
    }>>;
    readonly volume?: number;
}
```

### CaptureDocument

What the helpers need from a document.

```ts
export interface CaptureDocument extends EventTarget {
    readonly visibilityState?: string;
    readonly pointerLockElement?: Element | null;
}
```

### CaptureEnvironment

The browser, for a test to stand in for. Read when `attach` runs, never at import.

```ts
export interface CaptureEnvironment {
    /** Hears keys, `blur`, `deviceorientation`, and the pointer backstop. */
    readonly window: EventTarget;
    /** Hears `visibilitychange` and `pointerlockchange`. */
    readonly document: CaptureDocument;
    /** `navigator.getGamepads`. */
    readonly gamepads: () => readonly (Gamepad | null)[];
    /** How far the screen is turned from the device's natural orientation. */
    readonly screenAngle: () => number | undefined;
}
```

### CaptureMapping

Which device drives which of the game's inputs. Every part is optional.

```ts
export interface CaptureMapping {
    /** Presses, by `KeyboardEvent.code`. */
    readonly keys?: {
        readonly [code: string]: string;
    };
    /** Slot 0 is the first finger down, slot 1 the second, and so on. */
    readonly pointers?: readonly PointerSlot[];
    /** Levels: a mouse or pen moving with nothing pressed. */
    readonly hover?: {
        readonly x?: string;
        readonly y?: string;
    };
    /** Amounts: mouse movement while it is locked to the game. */
    readonly mouseLock?: {
        readonly dx?: string;
        readonly dy?: string;
        /** CSS pixels per unit recorded. 1 by default. */
        readonly pixelsPerUnit?: number;
    };
    /** Amounts: wheel notches. */
    readonly wheel?: {
        readonly x?: string;
        readonly y?: string;
        /** Notches per unit recorded. 1 by default. */
        readonly notchesPerUnit?: number;
    };
    /** By `Gamepad.index`, "0" to "3", or "any" for whichever is connected first. */
    readonly gamepads?: {
        readonly [slot: string]: GamepadMapping;
    };
    /**
     * Levels: which way gravity points across the screen, x to the right, y
     * up, z out of the screen, each mapped onto its name's range. Ask for it
     * with `requestMotion` first.
     */
    readonly tilt?: {
        readonly x?: string;
        readonly y?: string;
        readonly z?: string;
        /** The tilt in degrees that reads as the end of the range. 90 by default. */
        readonly fullAt?: number;
    };
}
```

### DeviceNotice

```ts
export interface DeviceNotice {
    readonly code: DeviceNoticeCode;
    readonly detail: string;
}
```

### FetchPackLoaderOptions

```ts
export interface FetchPackLoaderOptions {
    /** The manifest whose packs this fetches. */
    readonly manifest: Manifest;
    /**
     * Where a pack is fetched from. Packs are stored under their fingerprint,
     * so this is usually `(pack) => "/pack/" + pack.sha256`. It is built here,
     * from the manifest, because no frame message may carry a URL.
     */
    readonly url: (pack: AssetDeclaration) => string;
    /** Aborts every fetch this loader starts. */
    readonly signal?: AbortSignal;
    /** Stands in for the global `fetch`. */
    readonly fetch?: (input: string, init: RequestInit) => Promise<Response>;
}
```

### FrameInfo

```ts
export interface FrameInfo {
    readonly tick: number;
    readonly ticksThisFrame: number;
    readonly alpha: number;
    readonly elapsedMs: number;
    /** The packs the loop is holding for. Empty while it runs. */
    readonly waitingFor: readonly string[];
}
```

### GameHostOptions

```ts
export interface GameHostOptions<TView = unknown, TContainer = unknown, TConfig = PlainValue> {
    readonly module: GameModule<TView, TConfig>;
    readonly manifest: Manifest;
    readonly seed: string;
    /**
     * The config the session plays. Left out, it is `servedConfig(manifest)`,
     * every declared parameter at its default, which is what a platform serves
     * a ranked or practice run and what the conformance checks play.
     */
    readonly config?: TConfig;
    readonly presentation?: Presentation<TView, TContainer>;
    readonly container?: TContainer;
    readonly scheduler?: Scheduler;
    /** Ticks between state hashes. Defaults to one second of play. */
    readonly checkpointEvery?: number;
    /**
     * Where the session stops, with terminal `timeout`, if the game has not
     * ended it by then.
     *
     * A replay of a recording passes `Math.max(endTick, 1)`: the log ends
     * where the player stopped, and without a stop the replay carries on past
     * it and reports a different end tick for a session that did not diverge.
     * Left out, a session runs until the game ends it or `stop` is called.
     */
    readonly maxTicks?: number;
    /** A multiplier on how fast the session advances. Replay speed lives here. */
    readonly speed?: number;
    readonly onCheckpoint?: (checkpoint: Checkpoint) => void;
    readonly onEffects?: (effects: readonly Effect[], tick: number) => void;
    readonly onEnded?: (result: SessionResult) => void;
    readonly onFrame?: (info: FrameInfo) => void;
    readonly onError?: (error: unknown) => void;
    /**
     * Where inputs come from. Left out, the host collects them from devices and
     * the session is a live one. Given a recorded source, the very same loop
     * replays it - which is the point: replay is not a second code path.
     */
    readonly inputs?: InputSource;
    /** Continues from a snapshot instead of starting fresh. */
    readonly resumeFrom?: {
        readonly snapshot: Snapshot;
        readonly tick: number;
    };
    readonly presentationContext?: {
        readonly random: () => number;
        readonly assets: ReadonlyMap<string, ArrayBuffer | string>;
        readonly devicePixelRatio: number;
        readonly theme: string;
    };
    /**
     * The data packs. Every start pack must be preloaded, because the session
     * is built, and `init` runs, inside this constructor. Demand packs come
     * from the loader when the game hints at them or names them; while one it
     * named is missing, the host holds the loop.
     */
    readonly packs?: PackSupply;
}
```

### GamepadMapping

```ts
export interface GamepadMapping {
    /** Presses, by button index. */
    readonly buttons?: {
        readonly [button: string]: string;
    };
    /** Levels: how far an analog button, such as a trigger, is pressed. */
    readonly values?: {
        readonly [button: string]: string;
    };
    /** Levels: a stick axis, centred at the middle of its range. */
    readonly axes?: {
        readonly [axis: string]: string;
    };
}
```

### InputCaptureOptions

```ts
export interface InputCaptureOptions extends CaptureMapping {
    readonly manifest: Manifest;
    /** Where inputs go: a session's live queue, or a worker's. */
    readonly queue: InputSink;
    /**
     * Whether an event a script made is recorded: one whose `isTrusted` is
     * false, from `dispatchEvent` or `new KeyboardEvent(...)` rather than from
     * the player's own hands. Required, so every page says which it is.
     *
     * `"ignore"` is what a page playing a ranked or practice run on a platform
     * sets: there an input has to come from a device, or any script on the page
     * could play the run. `"record"` treats a scripted event like any other,
     * which a game played on its own page may want, to drive itself from a test
     * or a tool.
     *
     * It covers every event the helpers listen to: keys, pointers (presses,
     * positions, buttons, and movement under mouse lock), hover, the wheel, and
     * the blur, visibility and lock changes that release what is held.
     * Gamepads are polled through `navigator.getGamepads()`, which reports no
     * such mark, so a gamepad is read whatever this says. Tilt ignores a
     * scripted reading whatever this says, as it always has: a reading a script
     * made would also stand in for the sensor `requestMotion` waits to hear.
     */
    readonly scripted: ScriptedEvents;
    /**
     * The element the game is drawn on. A pointer's position is measured
     * across it, on each axis separately, so it must be the element the
     * playfield fills, stretched the same way. The wheel is heard on it.
     * Required when pointers, hover, mouse lock or the wheel are mapped.
     */
    readonly element?: HTMLElement;
    /** Required when a gamepad or mouse lock is mapped. */
    readonly onNotice?: (notice: DeviceNotice) => void;
    /** For a test. The browser's own by default. */
    readonly environment?: CaptureEnvironment;
}
```

### LoopStats

```ts
export interface LoopStats {
    readonly frames: number;
    readonly ticksRun: number;
    readonly mostTicksInAFrame: number;
    readonly droppedMs: number;
}
```

### MotionEnvironment

The browser, for a test to stand in for.

```ts
export interface MotionEnvironment {
    readonly window: EventTarget;
    readonly isSecureContext: boolean;
    /** `DeviceOrientationEvent`, and iOS's `requestPermission` on it. */
    readonly orientation: {
        readonly requestPermission?: () => Promise<string>;
    } | undefined;
    /** `screenAngleOf` the page, or undefined where the browser has neither. */
    screenAngle(): number | undefined;
    /** Whether the page's policy allows a sensor feature, where the browser can say. */
    allowsFeature(feature: string): boolean | undefined;
    setTimeout(run: () => void, ms: number): unknown;
    clearTimeout(handle: unknown): void;
}
```

### PackSupply

What a host is given to find packs with.

```ts
export interface PackSupply {
    /** Packs already in hand, by path. Every start pack must be here. */
    readonly preloaded?: ReadonlyMap<string, PackBytes>;
    /**
     * Fetches a pack a prefetch hint or `packsNeeded()` names. Left out, a
     * demand pack that is needed and not preloaded ends the session with
     * `E_PACK_NOT_DELIVERED` rather than holding the loop forever.
     */
    readonly loader?: PackLoader;
}
```

### PointerSlot

One finger's or the mouse's inputs, by slot.

```ts
export interface PointerSlot {
    /** A press: the pointer is down. */
    readonly down?: string;
    /** Levels: where it is while down, across the element, in each name's range. */
    readonly x?: string;
    readonly y?: string;
    /** Presses, by `PointerEvent.button`: 1 middle, 2 right, 3 back, 4 forward. */
    readonly buttons?: {
        readonly [button: string]: string;
    };
}
```

### Scheduler

Where the host's time comes from.

```ts
export interface Scheduler {
    now(): number;
    request(callback: (now: number) => void): number;
    cancel(handle: number): void;
}
```

### ScreenAngleSource

The two places a browser says how far its screen is turned.

```ts
export interface ScreenAngleSource {
    /** `window.orientation`, which iOS and Android browsers still have. */
    readonly orientation?: unknown;
    readonly screen?: {
        readonly orientation?: {
            readonly angle?: number;
            readonly type?: string;
        };
    };
}
```

### DeviceNoticeCode

```ts
export type DeviceNoticeCode = (typeof DEVICE_NOTICES)[keyof typeof DEVICE_NOTICES];
```

### HostState

```ts
export type HostState = "idle" | "running" | "paused" | "ended";
```

### MotionAccess

```ts
export type MotionAccess = {
    readonly granted: true;
} | {
    readonly granted: false;
    readonly code: MotionRefusal;
    readonly detail: string;
};
```

### MotionRefusal

```ts
export type MotionRefusal = (typeof MOTION_REFUSALS)[keyof typeof MOTION_REFUSALS];
```

### PackLoader

Fetches one pack by its manifest path.

```ts
export type PackLoader = (path: string) => Promise<PackBytes>;
```

### ScriptedEvents

What the helpers do with an event a script made rather than the browser: `"ignore"` records nothing from one, `"record"` treats it as the player's.

```ts
export type ScriptedEvents = "record" | "ignore";
```

### SoundRecipe

```ts
export type SoundRecipe = (sampleRate: number, write: (index: number, value: number) => void, samples: number) => void;
```

## `@clockwork2/engine/worker`

The simulation in a worker, and the page's side of it. Packs cross as transferred buffers.

### WorkerSimulation

The page side.

```ts
export declare class WorkerSimulation {
    /** Packs sent to the worker, so a repeated hint does not send them again. */
    constructor(options: WorkerSimulationOptions);
    /**
     * Where an `InputCapture` on the page records, for a simulation in a
     * worker: inputs are collected and go to the worker's queue, which stamps
     * them, in one message before each frame the page offers, and a polled
     * device is read at the start of that frame.
     */
    readonly inputs: InputSink;
    /** Inputs pushed since the last message to the worker. */
    /** Sends `inputs`, and everything collected before them, to the worker. */
    send(inputs: readonly PendingInput[]): void;
    /**
     * Pauses the run: whatever the page's capture holds is released and sent,
     * then the worker's queue stops taking input and no frame is offered until
     * `resume`. A press while paused would otherwise land on the tick the run
     * resumes at, which is not when the player made it.
     */
    pause(): void;
    resume(): void;
    /**
     * Offers a frame's elapsed time.
     *
     * While one frame is outstanding the time is carried rather than queued, so
     * no simulation time is lost and no stale frame is ever sent.
     */
    frame(elapsedMs: number): void;
    stop(): void;
    terminate(): void;
}
```

### runSimulationWorker

The worker side. A game's worker entry is three lines:

```ts
export declare function runSimulationWorker(create: () => GameModule, manifest: Manifest, scope?: WorkerScope): void;
```

### WorkerScope

The least a worker scope has to provide. Narrower than `DedicatedWorkerGlobalScope` on purpose, so a test can stand in for one without inventing a MessageEvent.

```ts
export interface WorkerScope {
    postMessage: (message: FromWorker) => void;
    addEventListener: (type: "message", listener: (event: {
        readonly data: unknown;
    }) => void) => void;
}
```

### WorkerSimulationOptions

```ts
export interface WorkerSimulationOptions {
    /** The caller owns the Worker, so the bundler resolves its URL, not us. */
    readonly worker: Worker;
    readonly seed: string;
    /**
     * The config the session plays. Left out, the worker plays
     * `servedConfig(manifest)`, every declared parameter at its default, which
     * is what a platform serves and what the conformance checks play.
     */
    readonly config?: PlainValue;
    /**
     * Where the session stops, with terminal `timeout`, if the game has not
     * ended it by then: `Math.max(endTick, 1)` for a replay. Left out, the
     * session runs until the game ends it or `stop` is called.
     */
    readonly maxTicks?: number;
    readonly onFrame?: (frame: {
        tick: number;
        alpha: number;
        view: unknown;
        running: boolean;
    }) => void;
    readonly onCheckpoint?: (checkpoint: {
        tick: number;
        hash: string;
    }) => void;
    readonly onEffects?: (effects: unknown, tick: number) => void;
    readonly onEnded?: (result: Pick<SessionResult, "endTick" | "counters" | "snapshot"> & {
        terminal: string;
        inputs: readonly InputEvent[];
    }) => void;
    /** `code` is the kernel's, when the failure carried one. */
    readonly onError?: (detail: string, code?: string) => void;
    /**
     * The data packs. Start packs must be preloaded: they go to the worker with
     * `init`. Demand packs come from the loader when the game hints at them or
     * the worker holds for them.
     */
    readonly packs?: PackSupply;
}
```

### FromWorker

```ts
export type FromWorker = {
    readonly type: "ready";
} | {
    readonly type: "frame";
    readonly frameId: number;
    readonly tick: number;
    readonly alpha: number;
    readonly view: unknown;
    readonly running: boolean;
} | {
    readonly type: "checkpoint";
    readonly tick: number;
    readonly hash: string;
} | {
    readonly type: "effects";
    readonly effects: unknown;
    readonly tick: number;
} | {
    readonly type: "ended";
    readonly result: {
        readonly endTick: number;
        readonly terminal: string;
        readonly counters: Counters;
        readonly snapshot: Snapshot;
    };
    readonly inputs: readonly InputEvent[];
} | {
    /** The loop is holding for these. The page fetches and sends them. */
    readonly type: "packs-needed";
    readonly paths: readonly string[];
} | {
    readonly type: "error";
    readonly detail: string;
    /** The kernel's code, when the failure carried one. */
    readonly code?: string;
};
```

### PackTransfer

One pack on its way to the worker. The buffer is transferred, so the page sends a copy it made for the purpose and keeps nothing of it.

```ts
export type PackTransfer = {
    readonly path: string;
    readonly bytes: ArrayBuffer;
};
```

### ToWorker

```ts
export type ToWorker = {
    readonly type: "init";
    readonly seed: string;
    /** Left out, the worker plays `servedConfig(manifest)`. */
    readonly config?: PlainValue;
    /** Where the session stops. Left out, it runs until the game ends it. */
    readonly maxTicks?: number;
    /** Every start pack, and any demand pack the page already has. */
    readonly packs?: readonly PackTransfer[];
} | {
    readonly type: "packs";
    readonly packs: readonly PackTransfer[];
} | {
    readonly type: "input";
    readonly inputs: readonly PendingInput[];
} | {
    readonly type: "frame";
    readonly elapsedMs: number;
    readonly frameId: number;
} | {
    readonly type: "pause";
} | {
    readonly type: "resume";
} | {
    readonly type: "stop";
};
```

## `@clockwork2/engine/validate`

The conformance suite, as a library. The CLI wraps this.

### findEntry

```ts
export declare function findEntry(target: string): string;
```

### formatReport

A report as a person reads it.

```ts
export declare function formatReport(report: Report): string;
```

### loadSubject

Builds a Subject from a directory or entry file.

```ts
export declare function loadSubject(target: string, options?: {
    /** A config to play instead of the served one. */
    readonly config?: unknown;
    /** The packs' bytes, instead of reading them from the bundle's directory. */
    readonly packs?: ReadonlyMap<string, Uint8Array>;
}): Promise<Subject>;
```

### readPacks

Reads each declared pack under `root`, at most one byte past its declared size.

```ts
export declare function readPacks(root: string, manifest: Manifest): Map<string, Uint8Array>;
```

### scanImportGraph

Reads the entry and everything it imports, and reports what it finds.

```ts
export declare function scanImportGraph(entry: string, options?: ScanOptions): ScanResult;
```

### validate

Runs a set of checks against a subject and reports every outcome.

```ts
export declare function validate(subject: Subject, options: ValidateOptions): Promise<Report>;
```

### BANNED_GLOBALS

Globals a simulation may not read at all.

```ts
BANNED_GLOBALS: ReadonlyMap<string, string>
```

### BANNED_IMPORTS

Renderer packages a simulation must not import.

```ts
BANNED_IMPORTS: readonly string[]
```

### BANNED_MEMBERS

Members that are banned wherever they are reached from.

```ts
BANNED_MEMBERS: ReadonlyMap<string, string>
```

### BANNED_PROPERTIES

Property names that are banned however the object was reached.

```ts
BANNED_PROPERTIES: ReadonlyMap<string, string>
```

### CHECK_SETS

Each set's checks, in the order they run. The ranked set is the every-game set and two more, which hold what a ranked or practice run on a platform needs and a game played only on its own page does not.

```ts
CHECK_SETS: Readonly<Record<CheckSet, readonly Check[]>>
```

### CHECK_WINDOW_TICKS

How far the checks play each log: 36,000 ticks, ten minutes at 60 Hz. A run the game has not ended by then stops there, with terminal `timeout`, and the report says where every run ended. Nothing is refused for running the whole window, because no run has a step limit; the window bounds what the suite costs and nothing else.

```ts
CHECK_WINDOW_TICKS = 36000
```

### DEFAULT_SEEDS

```ts
DEFAULT_SEEDS: string[]
```

### SENSITIVITY_SEEDS

The two seeds the seed check plays, which no other check uses. They are the seeds vbz's platform played when this check was its own. That check compared only where each run ended, and this one compares every checkpoint as well, so a game it passed passes here too.

```ts
SENSITIVITY_SEEDS: readonly ["vbz-seed-a", "vbz-seed-b"]
```

### SENSITIVITY_TICKS

How far the seed check plays each log: 3,600 ticks, a minute at 60 Hz, as the platform's own check did. It runs six sessions, two seeds over three logs, and stops at the first log whose two runs differ.

```ts
SENSITIVITY_TICKS = 3600
```

### ScanOptions

```ts
export interface ScanOptions {
    /**
     * Import specifiers whose files are not scanned, because the platform ships
     * them and audits them separately. The kernel names `Date` and
     * `performance` in its own trap table, so scanning it would report the
     * mechanism as a violation.
     */
    readonly trustedPrefixes?: readonly string[];
    /** A cap, so a cycle or a huge graph cannot run away. */
    readonly maxFiles?: number;
}
```

### ValidateOptions

```ts
export interface ValidateOptions {
    /**
     * Which checks run: `every-game`, what any game on the engine needs, or
     * `ranked`, those and the checks a ranked or practice run on a platform
     * needs. Required, so every caller says which question it is asking.
     */
    readonly set: CheckSet;
    /** Seeds every check runs against. More seeds, more confidence, more time. */
    readonly seeds?: readonly string[];
    /** Run only these checks of the set, by name. A name the set lacks throws. */
    readonly only?: readonly string[];
    /** Set false to leave the runtime traps off, for measuring their cost. */
    readonly shims?: boolean;
    readonly onProgress?: (name: string) => void;
}
```

### Check

```ts
export type Check = {
    readonly name: string;
    readonly title: string;
    run(context: CheckContext): Promise<Omit<CheckOutcome, "check" | "title" | "ms">>;
};
```

### CheckContext

```ts
export type CheckContext = {
    readonly subject: Subject;
    /** Seeds every check uses, so two runs of the suite are comparable. */
    readonly seeds: readonly string[];
    /** Set false to leave the runtime traps off, for measuring their cost. */
    readonly shims: boolean;
};
```

### CheckOutcome

```ts
export type CheckOutcome = {
    readonly check: string;
    readonly title: string;
    readonly ok: boolean;
    /** Set when a check could not run at all, rather than ran and failed. */
    readonly skipped?: string;
    readonly findings: readonly Finding[];
    /** Anything worth printing on a pass: a measurement, a count. */
    readonly note?: string;
    /**
     * The numbers behind the note, for a platform to read rather than parse.
     * The performance check reports `microsecondsPerTick`, `peakMemoryBytes`
     * and the engine that measured them, `memoryEngine`.
     */
    readonly measurements?: Readonly<Record<string, number | string>>;
    /**
     * Where each seed's run of each log ended. The determinism check reports
     * it, because it plays every log on every seed to its end or to the check
     * window. A game that runs the whole window is not refused for it.
     */
    readonly ends?: readonly RunEnd[];
    readonly ms: number;
};
```

### CheckSet

Which checks a caller runs. `every-game` is what any game on the engine needs. `ranked` adds what a ranked or practice run on a platform needs: that the seed changes the game, and that the manifest says how a run ranks. There is no default; every caller names its set.

```ts
export type CheckSet = "every-game" | "ranked";
```

### Finding

```ts
export type Finding = {
    readonly code: ErrorCode;
    /** Which check produced it. */
    readonly check: string;
    readonly detail: string;
    /** Where in the session, when that is known. */
    readonly tick?: number;
    /** Where in the source, when that is known. */
    readonly at?: string;
};
```

### Report

```ts
export type Report = {
    /** The set that ran. */
    readonly set: CheckSet;
    readonly ok: boolean;
    readonly outcomes: readonly CheckOutcome[];
    readonly ms: number;
};
```

### RunEnd

Where one seed's run of one of the three logs ended, as the determinism check played it.

```ts
export type RunEnd = {
    readonly seed: string;
    /** `idle`, `chaos` or `bot`. */
    readonly log: string;
    readonly endTick: number;
    /**
     * How it ended: `completed` when the game ended it, `timeout` when it was
     * still running when the check window closed at `CHECK_WINDOW_TICKS`.
     */
    readonly terminal: TerminalReason;
};
```

### ScanFinding

```ts
export type ScanFinding = {
    readonly kind: ScanFindingKind;
    readonly name: string;
    readonly why: string;
    readonly file: string;
    readonly line: number;
    readonly column: number;
};
```

### ScanFindingKind

The static scan: what a simulation names, across its whole import graph.

```ts
export type ScanFindingKind = "global" | "member" | "property" | "import" | "exponent" | "async";
```

### ScanResult

```ts
export type ScanResult = {
    /** Every file the scan read, in the order it reached them. */
    readonly files: readonly string[];
    /** Specifiers it could not resolve, which are reported rather than ignored. */
    readonly unresolved: readonly string[];
    /** Packages excluded as platform-provided. */
    readonly trusted: readonly string[];
    readonly findings: readonly ScanFinding[];
};
```

### Subject

What is being checked.

```ts
export type Subject = {
    readonly manifest: Manifest;
    /**
     * Produces a module instance.
     *
     * The platform evaluates the module afresh per session rather than taking a
     * fresh instance, because a fresh instance does not reset a module-level
     * counter - which is exactly what tiki-kong's static ids relied on. Pass
     * `fresh: true` to ask for a newly evaluated module where the caller can
     * provide one.
     */
    readonly load: (options?: {
        readonly fresh?: boolean;
    }) => Promise<GameModule> | GameModule;
    /** The simulation's entry file, for the static scan. */
    readonly entry?: string;
    /** The directory holding the bundle and its assets, for the budget check. */
    readonly root?: string;
    /**
     * The config every check plays. `loadSubject` sets it to
     * `servedConfig(manifest)`, every declared parameter at its default, unless
     * it is given another. A subject built by hand without one plays the served
     * config too, never an empty one.
     */
    readonly config?: unknown;
    /**
     * The bytes of the game's data packs, by manifest path, unchecked. The
     * suite checks them once and gives the result to every session it runs, so
     * a pack that is missing or wrong is reported with its own code by every
     * check that runs the game.
     */
    readonly packs?: ReadonlyMap<string, Uint8Array>;
};
```
