# Kernel API

**Generated from the built type declarations. Do not edit.**
Regenerate with `bun run scripts/gen-skill-api.ts`; `skill/tests/skill.test.ts`
fails when this file and the declarations disagree.

Anything not listed here is not part of the contract. Where this reference
and `@clockwork2/validate` disagree, the validator is right.

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

The one error type. Catching code switches on `code`, never on the message, and never on a substring of it.

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

Collects device events between frames and stamps them at the moment the simulation reaches a tick. The log it builds is the recording.

```ts
export declare class LiveInputQueue implements InputSource {
    /** Called by the host from a device event handler. */
    push(input: PendingInput): void;
    take(tick: number): readonly InputEvent[];
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
    /** The packs in this set, in the order they were given. */
    get paths(): readonly string[];
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
    /** Packs checked before the session, possibly shared with other sessions. */
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
     * kept, and so is everything in a shared set.
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

Drives a session to its end. This is what the validator runs.

```ts
export declare function runSession<TView = unknown, TConfig = PlainValue>(options: SessionOptions<TView, TConfig>): SessionResult;
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
    /** An input carried a value outside the range the device vocabulary allows. */
    readonly E_INPUT_RANGE: "input value is out of range";
    /** The session passed the tick cap its manifest declares. */
    readonly E_TICK_LIMIT: "session passed maxTicks without ending";
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
    /** isOver() never became true inside maxTicks. */
    readonly E_BOUND_NOT_OVER: "the run does not end inside maxTicks";
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
}
```

### INPUT_DEVICES

The devices a host may build an input from.

```ts
INPUT_DEVICES: readonly ["key", "pointer", "touch", "gamepad", "virtual"]
```

### KERNEL_VERSION

The major of this constant is pinned by a game's manifest. A bundle built against a different kernel major is refused rather than run.

```ts
KERNEL_VERSION = "0.8.0"
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
RECORDING_VERSION = 2
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
    readonly device: InputDevice;
    readonly code: string;
    readonly value: number;
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
    /** The tick cap from the manifest. The run ends here whatever the game says. */
    readonly maxTicks: number;
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
     * Packs the kernel has already checked. Every start pack must be here,
     * because `init` runs inside the constructor and may read one. Demand packs
     * may be here too, or arrive later through `deliver`.
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

### InputDevice

```ts
export type InputDevice = (typeof INPUT_DEVICES)[number];
```

### InputEvent

One input, stamped with the tick it applies to.

```ts
export type InputEvent = {
    readonly tick: number;
    readonly device: InputDevice;
    readonly code: string;
    readonly value: number;
};
```

### Manifest

```ts
export type Manifest = {
    readonly schemaVersion: 1;
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
    readonly inputs: {
        readonly map: {
            readonly [action: string]: readonly InputBinding[];
        };
        readonly controls?: Controls;
    };
    readonly counters: readonly CounterDeclaration[];
    readonly rankBy: readonly string[];
    readonly tiePolicy: TiePolicy;
    readonly params?: ParamSchema;
    readonly assets?: readonly AssetDeclaration[];
    readonly budgets?: Budgets;
    readonly display?: Display;
    readonly capabilities: Capabilities;
};
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

### botLog

A plausible player: holds a direction for a while, thrusts in bursts.

```ts
export declare function botLog(seed: string, endTick: number): readonly InputEvent[];
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

Running a game in a page: the accumulator loop, pack loading, input capture and the frame protocol. Not reachable from a simulation.

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

Listens for device events and pushes actions onto the queue.

```ts
export declare class InputCapture {
    /** pointerId to the small slot number its device codes are spelled with. */
    /** The last value pushed per analog code, so a repeat is not an input. */
    constructor(options: InputCaptureOptions);
    /** The device codes this game listens for, for a controls card. */
    get codes(): readonly string[];
    attach(): void;
    /**
     * Which finger this is, as a small stable number.
     *
     * `PointerEvent.pointerId` is assigned by the browser and is neither small
     * nor comparable between runs, so it cannot appear in a device code. A slot
     * can: the lowest free index at `pointerdown`, freed at `pointerup`. One
     * finger is always slot 0, and the assignment is a pure function of the
     * order the events arrived in, which is the order the log records.
     *
     * Without this every touch shared one code. Two fingers interleaved into
     * one stream of coordinates, and the first to lift sent a release while the
     * other was still down - so a game drawing its own d-pad and a jump button
     * could not have both.
     */
    /** A press from a host-drawn on-screen control. The only virtual source. */
    virtual(action: string, value: number): void;
    /**
     * A value that is not a press: a coordinate, an axis.
     *
     * It goes through the manifest's binding table like a key does, so a game's
     * `tick` sees the action it named rather than `pointer0-x`, and a code the
     * game did not bind is dropped instead of filling the log. Repeats are
     * dropped too: `pointermove` fires far more often than a quantised
     * coordinate changes, and an unchanged value is not an input.
     */
    /** Releases everything held, so a session that loses focus does not stick. */
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

### bindingsFrom

Builds a device-code to action lookup from the manifest.

```ts
export declare function bindingsFrom(manifest: Manifest): ReadonlyMap<string, ActionBinding>;
```

### browserScheduler

The real one: `requestAnimationFrame` over `performance.now`.

```ts
export declare function browserScheduler(): Scheduler;
```

### createDispatcher

Builds a dispatcher from a complete table.

```ts
export declare function createDispatcher<T extends {
    readonly type: string;
}>(table: HandlerTable<T>): (message: unknown) => boolean;
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

### FRAME_ERRORS

What the frame reports when the conversation itself goes wrong.

```ts
FRAME_ERRORS: {
    /** `start` arrived before `init`, so there is no session to start. */
    readonly NOT_INITIALISED: "E_FRAME_NOT_INITIALISED";
    /** A second `init` arrived. A frame runs one session and is then done. */
    readonly ALREADY_INITIALISED: "E_FRAME_ALREADY_INITIALISED";
    /** Building the session from `init` threw. */
    readonly INIT_FAILED: "E_FRAME_INIT_FAILED";
    /** A second `start` arrived. One session is started once. */
    readonly ALREADY_STARTED: "E_FRAME_ALREADY_STARTED";
    /** The loop threw while running the player's own inputs. */
    readonly THREW: "E_FRAME_THREW";
}
```

### LOG_CHUNK_INTERVAL_MS

At most this often for a slice of the input log.

```ts
LOG_CHUNK_INTERVAL_MS = 2000
```

### PROGRESS_INTERVAL_MS

At most this often, so a frame cannot flood the host with progress.

```ts
PROGRESS_INTERVAL_MS = 250
```

### PROTOCOL_VERSION

```ts
PROTOCOL_VERSION = 1
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
    readonly config?: TConfig;
    readonly presentation?: Presentation<TView, TContainer>;
    readonly container?: TContainer;
    readonly scheduler?: Scheduler;
    /** Ticks between state hashes. Defaults to one second of play. */
    readonly checkpointEvery?: number;
    /**
     * A cap below the manifest's.
     *
     * Replaying a recording that was abandoned mid-run needs one: the log ends
     * where the player stopped, and without a cap the replay carries on past it
     * and reports a different end tick for a session that did not diverge.
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

### InputCaptureOptions

```ts
export interface InputCaptureOptions {
    readonly manifest: Manifest;
    readonly queue: LiveInputQueue;
    /** Where key events are listened for. Defaults to the container's document. */
    readonly keyTarget?: EventTarget;
    /** Where pointer events are listened for. */
    readonly pointerTarget?: HTMLElement;
    /** The simulation's coordinate space, for mapping a pointer into it. */
    readonly viewport?: {
        readonly width: number;
        readonly height: number;
    };
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

### Scheduler

Where the host's time comes from.

```ts
export interface Scheduler {
    now(): number;
    request(callback: (now: number) => void): number;
    cancel(handle: number): void;
}
```

### ActionBinding

```ts
export type ActionBinding = {
    readonly action: string;
    readonly device: InputDevice;
};
```

### GameToHost

```ts
export type GameToHost = {
    readonly type: "ready";
    readonly protocol: number;
    readonly manifestHash: string;
    readonly kernelVersion: string;
} | {
    readonly type: "started";
} | {
    readonly type: "progress";
    readonly tick: number;
    readonly counters: Counters;
} | {
    readonly type: "checkpoint";
    readonly tick: number;
    readonly hash: string;
} | {
    readonly type: "ended";
    readonly tick: number;
    readonly counters: Counters;
    readonly reason: TerminalReason;
    readonly finalSnapshot: Snapshot;
} | {
    /**
     * A slice of the input log, sent while the run is still going.
     *
     * `ended` carries the whole recording, but it arrives once the player
     * knows how they did. These arrive before that, so a host can keep what
     * the log looked like at a moment it stamped itself. A submitted log
     * whose past disagrees with a slice already sent is one the host can
     * refuse without replaying anything.
     */
    readonly type: "log-chunk";
    /** Where this slice starts in the whole log. */
    readonly fromIndex: number;
    readonly inputs: readonly InputEvent[];
} | {
    readonly type: "recording-chunk";
    readonly index: number;
    readonly total: number;
    readonly data: string;
} | {
    readonly type: "error";
    readonly code: string;
    readonly detail: string;
} | {
    readonly type: "heartbeat";
    readonly tick: number;
};
```

### HandlerTable

A handler for each message type, and nothing else.

```ts
export type HandlerTable<T extends {
    readonly type: string;
}> = {
    readonly [K in MessageType<T>]: (message: Extract<T, {
        type: K;
    }>) => void;
};
```

### HostState

```ts
export type HostState = "idle" | "running" | "paused" | "ended";
```

### HostToGame

```ts
export type HostToGame = {
    readonly type: "hello";
    readonly protocol: number;
} | {
    readonly type: "init";
    readonly seed: string;
    readonly config: unknown;
    readonly tickHz: TickRate;
    readonly maxTicks: number;
    /**
     * A recorded log, which makes this session a replay rather than a run.
     *
     * The same loop plays it: a replay is not a second code path, it is a
     * session whose inputs come from a log instead of from devices. Left
     * out, the frame captures from real events as it always has.
     *
     * It is the one field here that could be mistaken for a way to feed a
     * player's inputs into their own live run, so the frame refuses to
     * capture device input for a session that carries one. A replay reads
     * its log and nothing else.
     */
    readonly inputs?: readonly InputEvent[];
    /**
     * How fast a replay advances. Only with `inputs`.
     *
     * A live session may never carry one. Speed on a live run is a player
     * slowing the game down to play it, which is the reason a frame does
     * not expose `setSpeed` at all, and the frame refuses an `init` that
     * asks for one without a log to replay.
     */
    readonly speed?: number;
} | {
    readonly type: "start";
} | {
    readonly type: "pause";
} | {
    readonly type: "resume";
} | {
    readonly type: "end";
} | {
    readonly type: "resize";
    readonly width: number;
    readonly height: number;
    readonly devicePixelRatio: number;
} | {
    readonly type: "theme";
    readonly theme: string;
} | {
    /** A host-drawn on-screen control. The only source of virtual inputs. */
    readonly type: "virtual-input";
    readonly action: string;
    readonly value: number;
};
```

### PackLoader

Fetches one pack by its manifest path.

```ts
export type PackLoader = (path: string) => Promise<PackBytes>;
```

### SoundRecipe

```ts
export type SoundRecipe = (sampleRate: number, write: (index: number, value: number) => void, samples: number) => void;
```

## `@clockwork2/engine/frame`

The game's half of the bridge, inside the sandboxed frame: where a frame fetches its start packs before it says ready.

### FrameBridge

```ts
export declare class FrameBridge<TView> {
    /** Settles when the start packs are here, or when fetching them failed. */
    constructor(options: FrameBridgeOptions<TView>);
    /** Call from the host's onCheckpoint. */
    checkpoint(tick: number, hash: string): void;
    /** Call from the host's onFrame. Rate-limited, so it cannot flood. */
    progress(tick: number, counters: Counters, now: number): void;
    /**
     * Sends whatever the input log has grown since the last slice.
     *
     * Call it from the host's onFrame beside `progress`. It sends nothing when
     * the log has not grown, and nothing at all for a replayed session, which
     * has no live queue to read.
     */
    logChunk(now: number): void;
    heartbeat(tick: number): void;
    /**
     * Call from the host's onEnded. Sends the result, the tail of the log, then
     * the recording.
     *
     * The tail matters: without it the last inputs of a run would only ever
     * reach the parent inside the recording, and the parent could not tell a log
     * that grew normally from one rewritten at the end.
     */
    ended(result: SessionResult, recording: string): void;
    /** Posts whatever the log has grown since the last slice. */
    error(code: string, detail: string): void;
    /**
     * Stops listening, and stops the session.
     *
     * Removing the listener alone left the host running: its scheduler kept
     * going and its onCheckpoint and onFrame callbacks kept calling back into
     * this bridge, so a destroyed frame carried on posting checkpoints at a
     * parent that was no longer there.
     */
    destroy(): void;
}
```

### connectToParent

Wires a host to a parent, including the callbacks it needs.

```ts
export declare function connectToParent<TView>(options: FrameBridgeOptions<TView>): FrameBridge<TView>;
```

### encodeRecording

```ts
export declare function encodeRecording(recording: Recording): string;
```

### FrameBridgeOptions

```ts
export interface FrameBridgeOptions<TView> {
    /**
     * Builds the session once the parent says what it is.
     *
     * Called at most once, from the `init` handler, with the bridge so the host's
     * callbacks can post back through it. Anything it throws is reported to the
     * parent as an error rather than left to a console nobody is reading.
     */
    readonly createHost: (init: FrameInit, bridge: FrameBridge<TView>) => GameHost<TView, HTMLElement>;
    /**
     * Read for the hash in `ready`, which the parent compares against the
     * version it pinned. It is needed before a host exists, so it is given here
     * rather than taken off one.
     */
    readonly manifest: Manifest;
    /** The platform origin this frame will talk to, and no other. */
    readonly parentOrigin: string;
    /** Splitting the recording keeps one postMessage from being enormous. */
    readonly chunkSize?: number;
    readonly onResize?: (width: number, height: number, devicePixelRatio: number) => void;
    readonly onTheme?: (theme: string) => void;
    /**
     * Fetches the game's data packs, usually a `fetchPackLoader` for the
     * frame's own address.
     *
     * The start packs are fetched as soon as the bridge exists, because they
     * belong to the game version rather than to a seed, and `ready` is not
     * sent until they are here. The bridge listens from the start all the same:
     * the parent says `hello` once, when the frame finishes loading, and a
     * frame that only began listening after a download would never hear it. A
     * parent sends `init` and `start` as soon as `ready` arrives, so holding
     * `ready` back is what keeps `start` from reaching a frame with no host. A
     * fetch that fails answers `hello` with an error instead.
     */
    readonly packs?: PackLoader;
}
```

### FrameInit

What the parent decided about this session, as `init` delivers it.

```ts
export interface FrameInit {
    readonly seed: string;
    readonly config: unknown;
    readonly tickHz: TickRate;
    readonly maxTicks: number;
    /**
     * A recorded log, present when this session is a replay.
     *
     * Pass it to `GameHost` as `inputs: new RecordedInputSource(init.inputs)`.
     * The same loop plays it, which is the point: a replay is a session whose
     * inputs come from a log instead of from devices.
     *
     * A game that receives one must not attach an `InputCapture`. `host.live`
     * is null for a replay, so the capture has no queue to write to, and a
     * device event reaching a replay would be an input nobody recorded.
     */
    readonly inputs?: readonly InputEvent[];
    /** How fast a replay advances. Never present on a live session. */
    readonly speed?: number;
    /**
     * The start packs, already fetched, and the loader for the rest. Present
     * when the bridge was given a loader. Pass it to `GameHost` as `packs`.
     */
    readonly packs?: PackSupply;
}
```

## `@clockwork2/engine/worker`

The simulation in a worker, and the page's side of it. Packs cross as transferred buffers.

### WorkerSimulation

The page side.

```ts
export declare class WorkerSimulation {
    /** Packs sent to the worker, so a repeated hint does not send them again. */
    constructor(options: WorkerSimulationOptions);
    send(inputs: readonly Omit<InputEvent, "tick">[]): void;
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
    readonly config?: PlainValue;
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
    readonly config: PlainValue;
    /** Every start pack, and any demand pack the page already has. */
    readonly packs?: readonly PackTransfer[];
} | {
    readonly type: "packs";
    readonly packs: readonly PackTransfer[];
} | {
    readonly type: "input";
    readonly inputs: readonly Omit<InputEvent, "tick">[];
} | {
    readonly type: "frame";
    readonly elapsedMs: number;
    readonly frameId: number;
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

```ts
export declare function validate(subject: Subject, options?: ValidateOptions): Promise<Report>;
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

### CHECKS

```ts
CHECKS: readonly Check[]
```

### DEFAULT_SEEDS

```ts
DEFAULT_SEEDS: string[]
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
    /** Seeds every check runs against. More seeds, more confidence, more time. */
    readonly seeds?: readonly string[];
    /** Run only these checks, by name. */
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
    readonly ms: number;
};
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
    readonly ok: boolean;
    readonly outcomes: readonly CheckOutcome[];
    readonly ms: number;
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
    /** A default config, when the game takes one. */
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
