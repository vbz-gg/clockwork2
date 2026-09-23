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
    constructor(options: SessionOptions<TView, TConfig>);
    get tick(): number;
    get running(): boolean;
    get checkpoints(): readonly Checkpoint[];
    /**
     * Runs exactly one tick.
     *
     * @returns whether the session is still running afterwards
     */
    step(): boolean;
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
    /** A file or the bundle exceeded its declared budget, or was undeclared. */
    readonly E_BUDGET_EXCEEDED: "bundle or asset budget exceeded, or a file is undeclared";
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
KERNEL_VERSION = "0.7.3"
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
    /** Deterministic setup. No I/O, no clock, no network. */
    init(seed: string, config: TConfig): void;
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

## `@clockwork2/engine`

Running a game in a page: the accumulator loop, input capture and the frame protocol. Not reachable from a simulation.

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
    constructor(options: SessionOptions<TView, TConfig>);
    get tick(): number;
    get running(): boolean;
    get checkpoints(): readonly Checkpoint[];
    /**
     * Runs exactly one tick.
     *
     * @returns whether the session is still running afterwards
     */
    step(): boolean;
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
    /** A file or the bundle exceeded its declared budget, or was undeclared. */
    readonly E_BUDGET_EXCEEDED: "bundle or asset budget exceeded, or a file is undeclared";
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
KERNEL_VERSION = "0.7.3"
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
    /** Deterministic setup. No I/O, no clock, no network. */
    init(seed: string, config: TConfig): void;
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

## `@clockwork2/engine/validate`

The conformance suite, as a library. The CLI wraps this.

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
    constructor(options: SessionOptions<TView, TConfig>);
    get tick(): number;
    get running(): boolean;
    get checkpoints(): readonly Checkpoint[];
    /**
     * Runs exactly one tick.
     *
     * @returns whether the session is still running afterwards
     */
    step(): boolean;
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
    /** A file or the bundle exceeded its declared budget, or was undeclared. */
    readonly E_BUDGET_EXCEEDED: "bundle or asset budget exceeded, or a file is undeclared";
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
KERNEL_VERSION = "0.7.3"
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
    /** Deterministic setup. No I/O, no clock, no network. */
    init(seed: string, config: TConfig): void;
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
