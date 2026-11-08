/**
 * The kernel half of data packs: checking bytes, decoding them, and what a
 * game may read when.
 *
 * Every test here is about one way a run could come to depend on something
 * other than its seed, config, inputs and pinned packs: a pack read at a step
 * the game did not choose, bytes nobody checked, a copy shared between two
 * runs, or a call count that differs between hosts.
 */

import { describe, expect, test } from "bun:test"
import { createHash } from "node:crypto"
import type {
  Counters,
  Effect,
  GameModule,
  PlainValue,
  Snapshot,
} from "../../src/contract"
import { ClockworkError, type ErrorCode } from "../../src/errors"
import { RecordedInputSource } from "../../src/inputs"
import { runSession, Session, type SessionOptions } from "../../src/loop"
import type { AssetDeclaration } from "../../src/manifest/types"
import {
  decodeJsonPack,
  decodeUtf8,
  logicPacks,
  MAX_JSON_PACK_BYTES,
  type PackReader,
  PackSet,
  prefetchPaths,
} from "../../src/packs"
import { compareResults } from "../../src/testing/compare"
import { packReaderFor } from "../../src/testing/packs"

const encode = (text: string) => new TextEncoder().encode(text)

function declare(
  path: string,
  bytes: Uint8Array,
  extra: Partial<AssetDeclaration> = {},
): AssetDeclaration {
  return {
    path,
    sha256: createHash("sha256").update(bytes).digest("hex"),
    bytes: bytes.byteLength,
    requiredForSim: true,
    license: "CC0-1.0",
    ...extra,
  }
}

const CORE = encode('{"speed":3}')
const LEVEL = encode('{"bonus":7}')
const ART = encode("not read by the simulation")
const ASSETS: readonly AssetDeclaration[] = [
  declare("packs/core.json", CORE),
  declare("packs/level-2.json", LEVEL, { load: "demand" }),
  declare("art/index.json", ART, { requiredForSim: false }),
]
const ALL = new Map<string, Uint8Array>([
  ["packs/core.json", CORE],
  ["packs/level-2.json", LEVEL],
])
const START_ONLY = new Map([["packs/core.json", CORE]])

function codeOf(body: () => unknown): ErrorCode | "no error" {
  try {
    body()
  } catch (error) {
    if (error instanceof ClockworkError) return error.code
    throw error
  }
  return "no error"
}

type Behaviour = {
  /** The tick from which packsNeeded() names the level. */
  readonly needFrom?: number
  /** The tick it stops naming it, or never. */
  readonly needUntil?: number
  /** Ticks [from, until) in which it names the level, instead of the two above. */
  readonly windows?: ReadonlyArray<readonly [number, number]>
  /** A tick at which the game emits a prefetch with this data. */
  readonly prefetchAt?: number
  readonly prefetch?: PlainValue
  /** Where the game reads the level without asking. */
  readonly readLevelIn?:
    | "init"
    | "restore"
    | "tick"
    | "view"
    | "snapshot"
    | "packsNeeded"
  readonly readPath?: string
  readonly needs?: unknown
  readonly endAt?: number
}

/**
 * A small game with one start pack and one demand pack. It records the tick
 * it first read the demand pack, which is the number every host must agree
 * on, and folds the pack's contents into its score so a wrong byte shows.
 */
class PackGame implements GameModule {
  readonly manifest = null
  packs: PackReader | null = null
  speed = 0
  bonus = 0
  ticks = 0
  openedAt = -1
  needsCalls = 0
  /** Parsed level, kept out of the snapshot and reopened after a restore. */
  private level: { bonus: number } | null = null

  constructor(private readonly behaviour: Behaviour = {}) {}

  private needed(tick: number): boolean {
    const { windows } = this.behaviour
    if (windows !== undefined) {
      return windows.some(([from, until]) => tick >= from && tick < until)
    }
    const from = this.behaviour.needFrom ?? 300
    const until = this.behaviour.needUntil ?? Number.POSITIVE_INFINITY
    return tick >= from && tick < until
  }

  init(_seed: string, _config: unknown, packs: PackReader): void {
    this.packs = packs
    this.speed = (packs.json("packs/core.json") as { speed: number }).speed
    this.bonus = 0
    this.ticks = 0
    this.openedAt = -1
    this.level = null
    if (this.behaviour.readLevelIn === "init") packs.open("packs/level-2.json")
  }

  tick(): void {
    const reader = this.packs as PackReader
    if (this.behaviour.readLevelIn === "tick" && this.ticks === 10) {
      reader.open(this.behaviour.readPath ?? "packs/level-2.json")
    }
    if (this.needed(this.ticks)) {
      this.level ??= reader.json("packs/level-2.json") as { bonus: number }
      if (this.openedAt < 0) this.openedAt = this.ticks
      this.bonus += this.level.bonus
    } else {
      this.level = null
    }
    this.ticks++
  }

  view(): unknown {
    if (this.behaviour.readLevelIn === "view") {
      this.packs?.open("packs/core.json")
    }
    return { ticks: this.ticks }
  }

  snapshot(): Snapshot {
    if (this.behaviour.readLevelIn === "snapshot") {
      this.packs?.open("packs/core.json")
    }
    return {
      speed: this.speed,
      bonus: this.bonus,
      ticks: this.ticks,
      openedAt: this.openedAt,
    }
  }

  restore(snapshot: Snapshot): void {
    this.speed = snapshot.speed as number
    this.bonus = snapshot.bonus as number
    this.ticks = snapshot.ticks as number
    this.openedAt = snapshot.openedAt as number
    this.level = null
    if (this.behaviour.readLevelIn === "restore") {
      this.packs?.open("packs/level-2.json")
    }
  }

  score(): Counters {
    return { score: this.bonus + this.speed * this.ticks }
  }

  isOver(): boolean {
    return this.ticks >= (this.behaviour.endAt ?? 600)
  }

  effects(): readonly Effect[] {
    const { prefetchAt, prefetch } = this.behaviour
    if (prefetchAt !== undefined && this.ticks === prefetchAt) {
      return [{ type: "prefetch", data: prefetch ?? "packs/level-2.json" }]
    }
    return []
  }

  packsNeeded(): readonly string[] {
    this.needsCalls++
    if (this.behaviour.needs !== undefined) {
      return this.behaviour.needs as readonly string[]
    }
    if (this.behaviour.readLevelIn === "packsNeeded") {
      this.packs?.open("packs/core.json")
    }
    return this.needed(this.ticks) ? ["packs/level-2.json"] : []
  }
}

function options(
  game: GameModule,
  extra: Partial<SessionOptions> = {},
): SessionOptions {
  return {
    module: game,
    seed: "packs",
    config: {},
    inputs: new RecordedInputSource([]),
    maxTicks: 2000,
    checkpointEvery: 60,
    assets: ASSETS,
    packs: PackSet.verify(ASSETS, ALL),
    ...extra,
  }
}

describe("PackSet.verify", () => {
  test("keeps the packs it was given and says which", () => {
    const set = PackSet.verify(ASSETS, ALL)
    expect(set.paths).toEqual(["packs/core.json", "packs/level-2.json"])
    expect(set.has("packs/core.json")).toBe(true)
    expect(set.has("art/index.json")).toBe(false)
  })

  test("refuses a path that is not a declared pack, art included", () => {
    expect(
      codeOf(() => PackSet.verify(ASSETS, [["packs/secret.json", CORE]])),
    ).toBe("E_PACK_UNDECLARED")
    expect(
      codeOf(() => PackSet.verify(ASSETS, [["art/index.json", ART]])),
    ).toBe("E_PACK_UNDECLARED")
    expect(codeOf(() => PackSet.verify(undefined, ALL))).toBe(
      "E_PACK_UNDECLARED",
    )
  })

  test("refuses more bytes than declared before it hashes them", () => {
    const longer = new Uint8Array(CORE.byteLength + 1)
    longer.set(CORE)
    expect(
      codeOf(() => PackSet.verify(ASSETS, [["packs/core.json", longer]])),
    ).toBe("E_PACK_TOO_LARGE")
  })

  test("refuses fewer bytes, and the right length with the wrong bytes", () => {
    expect(
      codeOf(() =>
        PackSet.verify(ASSETS, [["packs/core.json", CORE.subarray(1)]]),
      ),
    ).toBe("E_PACK_HASH_MISMATCH")
    const wrong = CORE.slice()
    wrong[0] = 0x20
    expect(
      codeOf(() => PackSet.verify(ASSETS, [["packs/core.json", wrong]])),
    ).toBe("E_PACK_HASH_MISMATCH")
  })

  test("keeps its own copy, so writing into the caller's buffer changes nothing", () => {
    // A Node Buffer's slice() is a view. The kernel must copy anyway.
    const buffer = Buffer.from(CORE)
    const set = PackSet.verify(ASSETS, [
      ["packs/core.json", buffer],
      ["packs/level-2.json", LEVEL.slice().buffer],
    ])
    buffer.fill(0)
    const game = new PackGame()
    runSession(options(game, { packs: set }))
    expect(game.speed).toBe(3)
  })

  test("refuses an object that only looks like a set", () => {
    const forged = Object.create(PackSet.prototype) as PackSet
    expect(codeOf(() => forged.paths)).toBe("E_ARG_INVALID")
    expect(
      codeOf(() => new Session(options(new PackGame(), { packs: forged }))),
    ).toBe("E_ARG_INVALID")
  })
})

describe("decodeUtf8", () => {
  test("agrees with a fatal TextDecoder on text from every plane", () => {
    const text = [
      "plain ascii",
      "café über",
      "中文 हिन्दी",
      "\u{1f600}\u{1f9ea}\u{10ffff}\u{10000}",
      "\u0000\u007f\u0080߿ࠀ￿",
    ].join("|")
    const bytes = encode(text)
    expect(decodeUtf8(bytes, "t")).toBe(
      new TextDecoder("utf-8", { fatal: true }).decode(bytes),
    )
  })

  test("decodes across its chunk boundary without splitting a pair", () => {
    const text = `${"a".repeat(4095)}\u{1f600}${"é".repeat(5000)}`
    expect(decodeUtf8(encode(text), "t")).toBe(text)
  })

  test("drops a leading byte order mark and keeps one anywhere else", () => {
    expect(decodeUtf8(new Uint8Array([0xef, 0xbb, 0xbf, 0x61]), "t")).toBe("a")
    expect(decodeUtf8(new Uint8Array([0x61, 0xef, 0xbb, 0xbf]), "t")).toBe("a﻿")
  })

  test("refuses what a fatal decoder refuses", () => {
    const invalid: number[][] = [
      [0x80], // a continuation byte with no lead
      [0xc0, 0xaf], // overlong
      [0xc1, 0xbf], // overlong
      [0xe0, 0x80, 0xaf], // overlong three-byte
      [0xf0, 0x80, 0x80, 0xaf], // overlong four-byte
      [0xed, 0xa0, 0x80], // a surrogate, U+D800
      [0xf4, 0x90, 0x80, 0x80], // past U+10FFFF
      [0xf5, 0x80, 0x80, 0x80], // a lead that cannot start anything
      [0xff],
      [0xc3], // truncated
      [0xe2, 0x82], // truncated
      [0xf0, 0x9f, 0x98], // truncated
      [0xc3, 0x28], // a lead followed by a non-continuation
    ]
    const strict = new TextDecoder("utf-8", { fatal: true })
    for (const bytes of invalid) {
      const array = new Uint8Array(bytes)
      expect(() => strict.decode(array)).toThrow()
      expect(
        codeOf(() => decodeUtf8(array, "t")),
        bytes.join(" "),
      ).toBe("E_ARG_INVALID")
    }
  })
})

describe("decodeJsonPack", () => {
  test("parses JSON with strings, escapes and numbers", () => {
    const value = decodeJsonPack(
      encode(
        '{"a":[1,-2.5,3e2],"b":"x\\"9999999999999999999999\\\\","c":null}',
      ),
      "t",
    )
    expect(value).toEqual({
      a: [1, -2.5, 300],
      b: 'x"9999999999999999999999\\',
      c: null,
    })
  })

  test("allows 20 significant digits and refuses 21", () => {
    // Leading and trailing zeros are not significant.
    for (const ok of [
      "12345678901234567890",
      "-0.0000000012345678901234567890",
      "1234567890123456789000000",
      "1.2345678901234567890e300",
      "0.00000000000000000000000000001",
    ]) {
      expect(() => decodeJsonPack(encode(`[${ok}]`), "t"), ok).not.toThrow()
    }
    for (const bad of [
      "123456789012345678901",
      "0.1000000000000000055511151231257827021181583404541015625",
      "-1.23456789012345678901e-5",
    ]) {
      expect(
        codeOf(() => decodeJsonPack(encode(`[${bad}]`), "t")),
        bad,
      ).toBe("E_ARG_INVALID")
    }
  })

  test("refuses invalid JSON and invalid UTF-8 with a stable code", () => {
    expect(codeOf(() => decodeJsonPack(encode("{nope"), "t"))).toBe(
      "E_ARG_INVALID",
    )
    expect(codeOf(() => decodeJsonPack(new Uint8Array([0xff]), "t"))).toBe(
      "E_ARG_INVALID",
    )
  })

  test("refuses a pack too long to be a string on V8, before reading it", () => {
    const huge = { byteLength: MAX_JSON_PACK_BYTES + 1 } as Uint8Array
    expect(codeOf(() => decodeJsonPack(huge, "t"))).toBe("E_ARG_INVALID")
  })
})

describe("what a game may read, and when", () => {
  test("a start pack is read in init, a demand pack from the tick it is named", () => {
    const game = new PackGame()
    const result = runSession(options(game))
    expect(game.speed).toBe(3)
    expect(game.openedAt).toBe(300)
    expect(result.counters.score).toBe(7 * 300 + 3 * 600)
  })

  test("logicPacks keeps only the packs, in declaration order", () => {
    expect([...logicPacks(ASSETS).keys()]).toEqual([
      "packs/core.json",
      "packs/level-2.json",
    ])
  })

  test("open returns a fresh copy every time", () => {
    const game = new PackGame()
    const session = new Session(options(game))
    const reader = game.packs as PackReader
    // Reading outside the game's own calls is refused, so read through init's
    // reader inside a tick by stepping a game that opens and writes.
    expect(session.packs).toBe(reader)
    const writer = new (class extends PackGame {
      firstByte = -1
      override tick(): void {
        const bytes = (this.packs as PackReader).open("packs/core.json")
        if (this.ticks === 0) bytes[0] = 0
        else this.firstByte = bytes[0] as number
        super.tick()
      }
    })()
    const shared = PackSet.verify(ASSETS, ALL)
    const first = new Session(options(writer, { packs: shared }))
    first.step()
    first.step()
    expect(writer.firstByte).toBe(CORE[0] as number)
    // A second session on the same shared set sees the original bytes too.
    const other = new PackGame()
    runSession(options(other, { packs: shared }))
    expect(other.speed).toBe(3)
  })

  test("a start pack missing at construction is not delivered", () => {
    expect(
      codeOf(
        () =>
          new Session(
            options(new PackGame(), {
              packs: PackSet.verify(ASSETS, [["packs/level-2.json", LEVEL]]),
            }),
          ),
      ),
    ).toBe("E_PACK_NOT_DELIVERED")
    expect(
      codeOf(() => {
        const { packs: _unused, ...withoutPacks } = options(new PackGame())
        return new Session(withoutPacks)
      }),
    ).toBe("E_PACK_NOT_DELIVERED")
  })

  test("a replay without the demand pack stops at the tick that needs it", () => {
    let caught: unknown
    try {
      runSession(
        options(new PackGame(), { packs: PackSet.verify(ASSETS, START_ONLY) }),
      )
    } catch (error) {
      caught = error
    }
    expect(caught).toBeInstanceOf(ClockworkError)
    expect((caught as ClockworkError).code).toBe("E_PACK_NOT_DELIVERED")
    expect((caught as ClockworkError).tick).toBe(300)
  })

  test("a session given no assets has no packs", () => {
    const bare = { ...options(new PackGame()) }
    delete (bare as { assets?: unknown }).assets
    delete (bare as { packs?: unknown }).packs
    expect(codeOf(() => new Session(bare))).toBe("E_PACK_NOT_DELIVERED")
    // A game that only names packs, with nothing to read, still learns why.
    const namer = new PackGame({ needs: ["packs/level-2.json"] })
    namer.init = () => {}
    expect(codeOf(() => new Session({ ...bare, module: namer }))).toBe(
      "E_PACK_NOT_DELIVERED",
    )
    expect(
      codeOf(() =>
        new Session({ ...bare, module: namer }).deliver(
          "packs/core.json",
          CORE,
        ),
      ),
    ).toBe("E_PACK_NOT_DELIVERED")
  })

  test("packs given without assets are refused as undeclared", () => {
    const bare = options(new PackGame())
    expect(codeOf(() => new Session({ ...bare, assets: [] }))).toBe(
      "E_PACK_UNDECLARED",
    )
  })

  test("a set checked against another manifest entry is refused", () => {
    const changed = ASSETS.map((asset) =>
      asset.path === "packs/core.json"
        ? { ...asset, sha256: "0".repeat(64) }
        : asset,
    )
    expect(
      codeOf(() => new Session(options(new PackGame(), { assets: changed }))),
    ).toBe("E_PACK_HASH_MISMATCH")
  })

  const READS: ReadonlyArray<
    [NonNullable<Behaviour["readLevelIn"]>, ErrorCode, number]
  > = [
    ["init", "E_PACK_NOT_REQUESTED", 0],
    ["tick", "E_PACK_NOT_REQUESTED", 10],
    // The view is read after the first step, as a host would.
    ["view", "E_PACK_NOT_REQUESTED", 1],
    ["snapshot", "E_PACK_NOT_REQUESTED", 0],
    ["packsNeeded", "E_PACK_NOT_REQUESTED", 0],
  ]
  for (const [where, code, tick] of READS) {
    test(`a read from ${where} is refused with ${code}`, () => {
      const game = new PackGame({ readLevelIn: where })
      let caught: unknown
      try {
        const session = new Session(options(game))
        while (session.step()) {
          game.view()
        }
      } catch (error) {
        caught = error
      }
      expect((caught as ClockworkError).code).toBe(code)
      expect((caught as ClockworkError).tick).toBe(tick)
    })
  }

  test("restore can read start packs and not demand ones", () => {
    const plain = new PackGame()
    const session = new Session(options(plain))
    for (let i = 0; i < 320; i++) session.step()
    const snapshot = session.result().snapshot
    const resume = { snapshot, tick: 320 }
    expect(
      codeOf(
        () =>
          new Session(
            options(new PackGame({ readLevelIn: "restore" }), {
              resumeFrom: resume,
            }),
          ),
      ),
    ).toBe("E_PACK_NOT_REQUESTED")
  })

  test("a resumed run after the demand pack opened equals one never stopped", () => {
    const whole = runSession(options(new PackGame()))
    const partial = new Session(options(new PackGame()))
    for (let i = 0; i < 400; i++) partial.step()
    const snapshot = JSON.parse(
      JSON.stringify(partial.result().snapshot),
    ) as Snapshot
    const resumed = runSession(
      options(new PackGame(), { resumeFrom: { snapshot, tick: 400 } }),
    )
    // The resumed run also pins tick 400, where it started; compare the
    // ticks both have.
    const later = whole.checkpoints.filter((c) => c.tick >= 400)
    const ticks = new Set(later.map((c) => c.tick))
    expect(later.length).toBeGreaterThan(3)
    expect(resumed.checkpoints.filter((c) => ticks.has(c.tick))).toEqual(later)
    expect(resumed.counters).toEqual(whole.counters)
  })

  test("an undeclared name is refused wherever the game hands it over", () => {
    const cases: ReadonlyArray<[string, Behaviour]> = [
      ["an open", { readLevelIn: "tick", readPath: "packs/secret.json" }],
      ["an open of art", { readLevelIn: "tick", readPath: "art/index.json" }],
      ["packsNeeded", { needs: ["packs/secret.json"] }],
      ["packsNeeded naming art", { needs: ["art/index.json"] }],
      ["packsNeeded returning a string", { needs: "packs/level-2.json" }],
      ["packsNeeded returning a number", { needs: [7] }],
      ["a prefetch", { prefetchAt: 5, prefetch: "packs/secret.json" }],
      ["a prefetch of a number", { prefetchAt: 5, prefetch: 42 }],
      [
        "a prefetch list",
        { prefetchAt: 5, prefetch: ["packs/level-2.json", "x"] },
      ],
    ]
    for (const [label, behaviour] of cases) {
      expect(
        codeOf(() => runSession(options(new PackGame(behaviour)))),
        label,
      ).toBe("E_PACK_UNDECLARED")
    }
    const session = new Session(options(new PackGame()))
    expect(codeOf(() => session.deliver("packs/secret.json", CORE))).toBe(
      "E_PACK_UNDECLARED",
    )
  })

  test("a declared prefetch passes through to the host's effects", () => {
    const seen: Effect[] = []
    runSession(
      options(new PackGame({ prefetchAt: 5 }), {
        onEffects: (effects) => seen.push(...effects),
      }),
    )
    expect(seen).toEqual([{ type: "prefetch", data: "packs/level-2.json" }])
    expect(prefetchPaths({ type: "sound" })).toBeNull()
    expect(prefetchPaths({ type: "prefetch", data: ["a", "b"] })).toEqual([
      "a",
      "b",
    ])
  })
})

describe("handing a demand pack over late", () => {
  test("delivered only when asked, the run is the same as with every pack at once", () => {
    const atOnce = runSession(options(new PackGame()))
    const game = new PackGame()
    const session = new Session(
      options(game, { packs: PackSet.verify(ASSETS, START_ONLY) }),
    )
    let held = 0
    for (;;) {
      const missing = session.packsMissing()
      if (missing.length > 0) {
        // A host would wait here for as long as the download takes. Asking
        // again while it waits must not move the game.
        held++
        for (let i = 0; i < 5; i++) session.packsMissing()
        for (const path of missing) {
          session.deliver(path, ALL.get(path) as Uint8Array)
        }
      }
      if (!session.step()) break
    }
    expect(held).toBe(1)
    expect(game.openedAt).toBe(300)
    expect(compareResults(atOnce, session.result()).differences).toEqual([])
  })

  test("packsNeeded runs once per tick, however often a host asks", () => {
    const quiet = new PackGame()
    runSession(options(quiet))
    const asked = new PackGame()
    const session = new Session(options(asked))
    for (;;) {
      session.packsMissing()
      session.packsMissing()
      if (!session.step()) break
    }
    expect(asked.needsCalls).toBe(quiet.needsCalls)
    // Once after init, then once after every tick but the last.
    expect(quiet.needsCalls).toBe(600)
  })

  test("deliver checks the bytes and keeps the first good copy", () => {
    const session = new Session(
      options(new PackGame(), { packs: PackSet.verify(ASSETS, START_ONLY) }),
    )
    expect(
      codeOf(() => session.deliver("packs/level-2.json", new Uint8Array(99))),
    ).toBe("E_PACK_TOO_LARGE")
    expect(
      codeOf(() =>
        session.deliver("packs/level-2.json", new Uint8Array(LEVEL.length)),
      ),
    ).toBe("E_PACK_HASH_MISMATCH")
    session.deliver("packs/level-2.json", LEVEL)
    // Already there, so even bad bytes are ignored rather than rechecked.
    session.deliver("packs/level-2.json", new Uint8Array(1))
    session.deliver("packs/core.json", new Uint8Array(1))
    expect(session.packsMissing()).toEqual([])
  })

  test("a delivered demand pack is released when the game stops naming it", () => {
    const game = new PackGame({
      windows: [
        [100, 200],
        [300, 350],
      ],
      endAt: 400,
    })
    const session = new Session(
      options(game, { packs: PackSet.verify(ASSETS, START_ONLY) }),
    )
    // Delivered before anything names it, as a prefetch would: kept.
    session.deliver("packs/level-2.json", LEVEL)
    for (let tick = 0; tick < 300; tick++) {
      expect(session.packsMissing(), `tick ${tick}`).toEqual([])
      session.step()
    }
    // Named from 100 to 199 and then not, so it was dropped at 200. Named
    // again for 300, the host has to send it again.
    expect(session.packsMissing()).toEqual(["packs/level-2.json"])
    session.deliver("packs/level-2.json", LEVEL)
    while (session.step()) {}
    expect(game.bonus).toBe(7 * 150)
    // And the result is the one a run holding every pack throughout reaches.
    const whole = new PackGame({
      windows: [
        [100, 200],
        [300, 350],
      ],
      endAt: 400,
    })
    expect(
      compareResults(runSession(options(whole)), session.result()).differences,
    ).toEqual([])
  })

  test("a pack in a shared set is never released", () => {
    const game = new PackGame({ needFrom: 100, needUntil: 200, endAt: 400 })
    const session = new Session(options(game))
    for (let i = 0; i < 400 && session.running; i++) {
      expect(session.packsMissing()).toEqual([])
      session.step()
    }
    expect(game.bonus).toBe(700)
  })

  test("an ended session needs nothing", () => {
    const session = new Session(options(new PackGame({ endAt: 2 })))
    while (session.step()) {}
    expect(session.packsMissing()).toEqual([])
  })
})

describe("packReaderFor, for a test that calls init by hand", () => {
  test("reads what it was given, as copies, and refuses the rest", () => {
    const reader = packReaderFor(new Map([["packs/core.json", CORE]]))
    const copy = reader.open("packs/core.json")
    copy[0] = 0
    expect(reader.open("packs/core.json")[0]).toBe(CORE[0] as number)
    expect(reader.json("packs/core.json")).toEqual({ speed: 3 })
    expect(codeOf(() => reader.open("packs/level-2.json"))).toBe(
      "E_PACK_UNDECLARED",
    )
    expect(codeOf(() => packReaderFor().json("x"))).toBe("E_PACK_UNDECLARED")
  })
})
