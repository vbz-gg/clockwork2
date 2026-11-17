import { describe, expect, test } from "bun:test"
import {
  assertManifest,
  mergeParamDefaults,
  type ParamSchema,
  type ParamValues,
  servedConfig,
  validateManifest,
  validateParams,
} from "../../src/manifest/index"
import { REFERENCE_MANIFEST } from "../../src/testing/reference-game"

function withoutIssues(value: unknown): void {
  expect(validateManifest(value)).toEqual([])
}

function issueAt(value: unknown, at: string): void {
  const issues = validateManifest(value)
  expect(
    issues.some((issue) => issue.at === at),
    `expected an issue at ${at}, got ${JSON.stringify(issues)}`,
  ).toBe(true)
}

describe("manifest validation", () => {
  test("the reference manifest is valid", () => {
    withoutIssues(REFERENCE_MANIFEST)
    expect(assertManifest(REFERENCE_MANIFEST)).toBe(REFERENCE_MANIFEST)
  })

  test("it reports every problem at once, not the first", () => {
    const issues = validateManifest({
      schemaVersion: 3,
      id: "X",
      version: "one",
    })
    expect(issues.length).toBeGreaterThan(3)
  })

  test("identity and version", () => {
    issueAt({ ...REFERENCE_MANIFEST, schemaVersion: 4 }, "schemaVersion")
    issueAt({ ...REFERENCE_MANIFEST, id: "Has Capitals" }, "id")
    issueAt({ ...REFERENCE_MANIFEST, id: "x" }, "id")
    issueAt({ ...REFERENCE_MANIFEST, version: "1.0" }, "version")
    withoutIssues({ ...REFERENCE_MANIFEST, version: "2.10.3-beta.1" })
  })

  test("a format 1 manifest is told what changed", () => {
    const issues = validateManifest({ ...REFERENCE_MANIFEST, schemaVersion: 1 })
    const issue = issues.find((i) => i.at === "schemaVersion")
    expect(issue?.message).toMatch(/inputs\.controls/)
    expect(issue?.message).toMatch(/device/)
    expect(issue?.message).toMatch(/session\.maxTicks/)
  })

  test("a format 2 manifest is refused and told what format 3 changed", () => {
    // The manifest as format 2 wrote it: a step limit, a time limit and a
    // bundle size, none of which anything reads any more.
    const formatTwo = {
      ...REFERENCE_MANIFEST,
      schemaVersion: 2,
      session: {
        tickHz: 60,
        maxTicks: 18_000,
        maxWallSeconds: 360,
        hasEnding: true,
      },
      budgets: { bundleBytes: 2_000_000 },
    }
    let caught: unknown
    try {
      assertManifest(formatTwo)
    } catch (error) {
      caught = error
    }
    expect((caught as { code?: unknown }).code).toBe("E_MANIFEST_INVALID")
    const issue = validateManifest(formatTwo).find(
      (i) => i.at === "schemaVersion",
    )
    expect(issue?.message).toMatch(/must be 3/)
    for (const field of [
      "session.maxTicks",
      "session.maxWallSeconds",
      "budgets.bundleBytes",
      "rankBy and tiePolicy",
    ]) {
      expect(issue?.message).toContain(field)
    }
  })

  test("format 3 refuses each field it removed, by name", () => {
    const session = REFERENCE_MANIFEST.session
    for (const [changed, at] of [
      [{ session: { ...session, maxTicks: 7200 } }, "session.maxTicks"],
      [
        { session: { ...session, maxWallSeconds: 300 } },
        "session.maxWallSeconds",
      ],
      [{ budgets: { bundleBytes: 2_000_000 } }, "budgets.bundleBytes"],
    ] as const) {
      const issue = validateManifest({
        ...REFERENCE_MANIFEST,
        ...changed,
      }).find((i) => i.at === at)
      expect(issue?.message, at).toMatch(
        /not in format 3: no run has a step limit/,
      )
    }
    withoutIssues({
      ...REFERENCE_MANIFEST,
      budgets: { assetBytes: 1_000, microsecondsPerTick: 400 },
    })
  })

  test("the session block", () => {
    const session = REFERENCE_MANIFEST.session
    issueAt(
      { ...REFERENCE_MANIFEST, session: { ...session, tickHz: 45 } },
      "session.tickHz",
    )
    issueAt(
      { ...REFERENCE_MANIFEST, session: { tickHz: 60 } },
      "session.hasEnding",
    )
    withoutIssues({
      ...REFERENCE_MANIFEST,
      session: { tickHz: 60, hasEnding: false },
    })
    for (const rate of [30, 60, 120]) {
      withoutIssues({
        ...REFERENCE_MANIFEST,
        session: { ...session, tickHz: rate },
      })
    }
  })

  test("counters and ranking", () => {
    issueAt({ ...REFERENCE_MANIFEST, counters: [] }, "counters")
    issueAt(
      {
        ...REFERENCE_MANIFEST,
        counters: [{ name: "score", direction: "sideways", monotonic: true }],
        rankBy: ["score"],
      },
      "counters[0].direction",
    )
    issueAt(
      {
        ...REFERENCE_MANIFEST,
        counters: [
          { name: "score", direction: "up", monotonic: true },
          { name: "score", direction: "up", monotonic: true },
        ],
      },
      "counters[1].name",
    )
    issueAt({ ...REFERENCE_MANIFEST, rankBy: ["nonesuch"] }, "rankBy[0]")
    issueAt({ ...REFERENCE_MANIFEST, rankBy: [] }, "rankBy")
    issueAt({ ...REFERENCE_MANIFEST, tiePolicy: "coin-toss" }, "tiePolicy")
  })

  test("ranking is optional, and declared whole or not at all", () => {
    const {
      rankBy: _rankBy,
      tiePolicy: _tiePolicy,
      ...unranked
    } = REFERENCE_MANIFEST
    // A game played only on its own page says nothing about ranking.
    withoutIssues(unranked)
    expect(assertManifest(unranked)).toBe(unranked)
    // Half a ranking is refused, at the half that is missing.
    const withoutTie = { ...unranked, rankBy: ["score"] }
    const withoutRank = { ...unranked, tiePolicy: "shared" }
    for (const [half, at] of [
      [withoutTie, "tiePolicy"],
      [withoutRank, "rankBy"],
    ] as const) {
      const issue = validateManifest(half).find((i) => i.at === at)
      expect(issue?.message, at).toMatch(/together, or neither/)
    }
    // The other half is still checked as it would be beside its partner.
    issueAt({ ...unranked, tiePolicy: "coin-toss" }, "tiePolicy")
    issueAt({ ...unranked, rankBy: ["nonesuch"] }, "rankBy[0]")
  })

  test("capabilities are refused where the platform has no room to move", () => {
    issueAt(
      {
        ...REFERENCE_MANIFEST,
        capabilities: {
          ...REFERENCE_MANIFEST.capabilities,
          deterministic: false,
        },
      },
      "capabilities.deterministic",
    )
    issueAt(
      {
        ...REFERENCE_MANIFEST,
        capabilities: { ...REFERENCE_MANIFEST.capabilities, multiplayer: true },
      },
      "capabilities.multiplayer",
    )
  })

  test("assets carry a hash, a size and a licence", () => {
    const withAssets = (assets: unknown) => ({ ...REFERENCE_MANIFEST, assets })
    withoutIssues(
      withAssets([
        {
          path: "levels/one.json",
          sha256: "a".repeat(64),
          bytes: 120,
          requiredForSim: true,
          license: "CC0-1.0",
        },
      ]),
    )
    issueAt(
      withAssets([
        {
          path: "a",
          sha256: "short",
          bytes: 1,
          requiredForSim: true,
          license: "x",
        },
      ]),
      "assets[0].sha256",
    )
    issueAt(
      withAssets([
        {
          path: "a",
          sha256: "a".repeat(64),
          bytes: 1,
          requiredForSim: true,
          license: "x",
        },
        {
          path: "a",
          sha256: "b".repeat(64),
          bytes: 1,
          requiredForSim: true,
          license: "x",
        },
      ]),
      "assets[1].path",
    )
  })

  test("assertManifest throws with a code and every reason", () => {
    let caught: unknown
    try {
      assertManifest({ schemaVersion: 9 })
    } catch (error) {
      caught = error
    }
    expect(String(caught)).toMatch(/E_MANIFEST_INVALID/)
    expect(String(caught)).toMatch(/schemaVersion/)
  })
})

describe("parameters", () => {
  const schema: ParamSchema = {
    theme: { type: "color", label: "Theme", default: "#112233" },
    palette: {
      type: "color",
      label: "Palette",
      allowed: ["#000000", "#ffffff"],
    },
    title: { type: "string", label: "Title", minLength: 2, maxLength: 8 },
    slug: { type: "string", label: "Slug", pattern: "[a-z]+" },
    mode: {
      type: "enum",
      label: "Mode",
      values: ["easy", "hard"],
      default: "easy",
    },
    lives: { type: "int", label: "Lives", min: 1, max: 9, default: 3 },
    music: { type: "bool", label: "Music", optional: true },
  }

  test("a complete set of values passes", () => {
    expect(
      validateParams(schema, {
        theme: "#aabbcc",
        palette: "#000000",
        title: "Hello",
        slug: "abc",
        mode: "hard",
        lives: 5,
        music: true,
      }),
    ).toEqual([])
  })

  test("a missing value with a default is fine; without one it is not", () => {
    const issues = validateParams(schema, { palette: "#000000", slug: "abc" })
    expect(issues.map((i) => i.at)).toEqual(["params.title"])
  })

  test("each type is checked", () => {
    const at = (values: Record<string, unknown>) =>
      validateParams(schema, values as never).map((i) => i.at)
    const base = {
      palette: "#000000",
      title: "Hello",
      slug: "abc",
    }
    expect(at({ ...base, theme: "red" })).toContain("params.theme")
    expect(at({ ...base, palette: "#123456" })).toContain("params.palette")
    expect(at({ ...base, title: "H" })).toContain("params.title")
    expect(at({ ...base, title: "much too long" })).toContain("params.title")
    expect(at({ ...base, slug: "ABC" })).toContain("params.slug")
    expect(at({ ...base, mode: "medium" })).toContain("params.mode")
    expect(at({ ...base, lives: 0 })).toContain("params.lives")
    expect(at({ ...base, lives: 2.5 })).toContain("params.lives")
    expect(at({ ...base, music: "yes" })).toContain("params.music")
  })

  test("a pattern is anchored at both ends", () => {
    // Unanchored, "ab1" would match /[a-z]+/ and slip through.
    expect(
      validateParams(schema, {
        palette: "#000000",
        title: "Hello",
        slug: "ab1",
      }).map((i) => i.at),
    ).toContain("params.slug")
  })

  test("a key the schema does not have is reported", () => {
    // game-base ignored these, so a typo in a config was invisible.
    const issues = validateParams(schema, {
      palette: "#000000",
      title: "Hello",
      slug: "abc",
      livez: 3,
    } as never)
    expect(issues.map((i) => i.at)).toContain("params.livez")
  })

  test("a hostile pattern cannot be compiled on every call", () => {
    // The pattern comes from a submitted manifest, so a length cap and a cache
    // keep new RegExp(untrusted) from being a denial-of-service surface.
    const long = "a".repeat(500)
    const issues = validateManifest({
      ...REFERENCE_MANIFEST,
      params: { x: { type: "string", label: "X", pattern: long } },
    })
    expect(issues.map((i) => i.at)).toContain("params.x.pattern")
  })

  describe("mergeParamDefaults", () => {
    test("an explicit value wins over a default", () => {
      expect(mergeParamDefaults(schema, { lives: 7 }).lives).toBe(7)
    })

    test("defaults fill in", () => {
      const merged = mergeParamDefaults(schema, null)
      expect(merged).toEqual({ theme: "#112233", mode: "easy", lives: 3 })
    })

    test("a parameter with neither is left out, not set to undefined", () => {
      // An undefined in a merged config would be refused by the canonical
      // encoder the moment the snapshot holding it was hashed.
      const merged = mergeParamDefaults(schema, null)
      expect("title" in merged).toBe(false)
      expect("music" in merged).toBe(false)
    })
  })

  describe("servedConfig", () => {
    test("is every declared parameter at its default, and nothing else", () => {
      const served = servedConfig({ ...REFERENCE_MANIFEST, params: schema })
      expect(served).toEqual({ theme: "#112233", mode: "easy", lives: 3 })
      expect(served).toEqual(mergeParamDefaults(schema, null))
    })

    test("is empty for a game that declares no parameters", () => {
      expect(servedConfig(REFERENCE_MANIFEST)).toEqual({})
    })
  })
})

/**
 * Every remaining rule, one manifest per rule.
 *
 * The rules matter because `assertManifest` is what the frame handshake and the
 * conformance suite's loader both stand on. A rule that stops firing lets a
 * malformed manifest into the platform, and the platform then ranks a game on
 * counters nobody declared or binds an input nothing can press.
 *
 * Each row breaks exactly one thing in a manifest that is otherwise the
 * reference one, and names the path the issue has to be reported at. Asserting
 * the path rather than the message is deliberate: a caller shows the path
 * beside the offending field, so a wrong path points a developer at the wrong
 * line.
 */
describe("one rule at a time", () => {
  const M = REFERENCE_MANIFEST
  const counter = { name: "score", direction: "up", monotonic: true }
  const asset = {
    path: "data/level.json",
    sha256: "a".repeat(64),
    bytes: 12,
    requiredForSim: true,
    license: "CC0-1.0",
  }

  const CASES: Array<[at: string, manifest: unknown]> = [
    // The whole document.
    ["", null],
    ["", ["not", "an", "object"]],
    ["", "a string is not a manifest"],

    // Identity.
    ["name", { ...M, name: "" }],
    ["kernel.version", { ...M, kernel: {} }],
    ["kernel.version", { ...M, kernel: { version: 1 } }],

    // The session block.
    ["session", { ...M, session: "soon" }],
    [
      "session.hasEnding",
      { ...M, session: { ...M.session, hasEnding: "yes" } },
    ],

    // Counters.
    ["counters[0]", { ...M, counters: ["score"] }],
    ["counters[0].name", { ...M, counters: [{ ...counter, name: "" }] }],
    ["counters[0].name", { ...M, counters: [{ ...counter, name: 7 }] }],
    [
      "counters[0].monotonic",
      { ...M, counters: [{ ...counter, monotonic: "sometimes" }] },
    ],
    // Two counters of one name would make rankBy ambiguous.
    [
      "counters[1].name",
      { ...M, counters: [counter, counter], rankBy: ["score"] },
    ],

    // Inputs: each declared by name and range.
    ["inputs", { ...M, inputs: [] }],
    ["inputs", { ...M, inputs: "push" }],
    [
      "inputs",
      {
        ...M,
        inputs: Object.fromEntries(
          Array.from({ length: 65 }, (_, i) => [`i${i}`, { min: 0, max: 1 }]),
        ),
      },
    ],
    // A name is what a recorded input carries, so it is a plain identifier.
    ...["Push", "push-up", "2push", "", "push up"].map(
      (name): [string, unknown] => [
        `inputs.${name}`,
        { ...M, inputs: { [name]: { min: 0, max: 1 } } },
      ],
    ),
    ["inputs.push", { ...M, inputs: { push: 1 } }],
    ["inputs.push.min", { ...M, inputs: { push: { max: 1 } } }],
    ["inputs.push.min", { ...M, inputs: { push: { min: 0.5, max: 1 } } }],
    ["inputs.push.max", { ...M, inputs: { push: { min: 0, max: 2 ** 31 } } }],
    ["inputs.push.max", { ...M, inputs: { push: { min: 5, max: 1 } } }],
    [
      "inputs.push.label",
      { ...M, inputs: { push: { min: 0, max: 1, label: 3 } } },
    ],
    // A field an input does not have is a typo, and is said so.
    [
      "inputs.push.device",
      { ...M, inputs: { push: { min: 0, max: 1, device: "key" } } },
    ],
    // Schema 1's binding table, kept by a stale template, says what changed.
    ["inputs.map", { ...M, inputs: { map: { push: [{ code: "Space" }] } } }],
    ["inputs.controls", { ...M, inputs: { controls: { mode: "custom" } } }],

    // Capabilities.
    ["capabilities", { ...M, capabilities: true }],
    [
      "capabilities.renderer",
      { ...M, capabilities: { ...M.capabilities, renderer: 2 } },
    ],
    [
      "capabilities.physics",
      { ...M, capabilities: { ...M.capabilities, physics: null } },
    ],

    // Params and assets.
    ["params", { ...M, params: [] }],
    ["assets", { ...M, assets: {} }],
    ["assets[0]", { ...M, assets: ["data/level.json"] }],
    ["assets[0].path", { ...M, assets: [{ ...asset, path: "" }] }],
    ["assets[1].path", { ...M, assets: [asset, asset] }],
    [
      "assets[0].sha256",
      { ...M, assets: [{ ...asset, sha256: "A".repeat(64) }] },
    ],
    ["assets[0].sha256", { ...M, assets: [{ ...asset, sha256: "abc" }] }],
    ["assets[0].bytes", { ...M, assets: [{ ...asset, bytes: 1.5 }] }],
    ["assets[0].bytes", { ...M, assets: [{ ...asset, bytes: -1 }] }],
    [
      "assets[0].requiredForSim",
      { ...M, assets: [{ ...asset, requiredForSim: "maybe" }] },
    ],
    ["assets[0].license", { ...M, assets: [{ ...asset, license: "" }] }],
    // A path the checker would read outside the bundle, or a host would turn
    // into a different request. Each is one way of escaping or redirecting.
    ...[
      "/etc/passwd",
      "../secret.json",
      "data/../../secret.json",
      "./data/level.json",
      "data//level.json",
      "data/level.json/",
      "data\\level.json",
      "C:/data/level.json",
      "data/%2e%2e/level.json",
      "data/level.json?v=2",
      "data/level.json#top",
      "data/level\u0000.json",
      "data/lev el.json",
      "data/n\u00edvel.json",
      ".hidden/../x",
    ].map((path): [string, unknown] => [
      "assets[0].path",
      { ...M, assets: [{ ...asset, path }] },
    ]),
    // Two spellings of one file on macOS and Windows.
    [
      "assets[1].path",
      { ...M, assets: [asset, { ...asset, path: "DATA/Level.json" }] },
    ],
    ["assets[0].load", { ...M, assets: [{ ...asset, load: "later" }] }],
    ["assets[0].load", { ...M, assets: [{ ...asset, load: true }] }],
    [
      "assets[0].load",
      { ...M, assets: [{ ...asset, requiredForSim: false, load: "start" }] },
    ],
  ]

  for (const [at, manifest] of CASES) {
    test(`${at === "" ? "<root>" : at}`, () => {
      issueAt(manifest, at)
    })
  }

  test("declared inputs of every shape are accepted", () => {
    // The negative rows above fire on any mistake, so they need a positive
    // case or they would pass against a validator that refused every input.
    withoutIssues({
      ...M,
      inputs: {
        jump: { min: 0, max: 1, label: "Jump" },
        aimX: { min: 0, max: 31 },
        steer: { min: -10, max: 10 },
        fixed: { min: 3, max: 3 },
        wide: { min: -(2 ** 31 - 1), max: 2 ** 31 - 1 },
      },
    })
    // A game with nothing to press, such as one that plays itself, is fine.
    withoutIssues({ ...M, inputs: {} })
    withoutIssues(M)
  })

  test("a stale binding table is told what replaced it", () => {
    const issues = validateManifest({
      ...M,
      inputs: { map: { push: [{ code: "Space" }] } },
    })
    expect(issues.find((i) => i.at === "inputs.map")?.message).toMatch(
      /declares each input as \{ min, max \}/,
    )
  })

  test("a manifest carrying valid assets and params is accepted", () => {
    // The negative rows above are only worth something if the positive one
    // passes; otherwise they would all fire on some unrelated mistake.
    withoutIssues({
      ...M,
      assets: [asset, { ...asset, path: "data/other.json" }],
      params: { lives: { type: "int", label: "Lives", min: 1, max: 9 } },
    })
  })

  test("pack paths and both load values are accepted", () => {
    // The path rule is an allow-list, so the positive case matters as much as
    // the escapes above: a rule that refused everything would pass them all.
    withoutIssues({
      ...M,
      assets: [
        { ...asset, path: "packs/towns/harbor-1.v2_final.json" },
        { ...asset, path: "a" },
        { ...asset, path: ".well-known" },
        { ...asset, path: "packs/core.json", load: "start" },
        { ...asset, path: "packs/level-2.json", load: "demand" },
        { ...asset, path: "art/index.json", requiredForSim: false },
      ],
    })
  })
})

describe("a parameter definition the game got wrong", () => {
  /**
   * These are the schema's own mistakes rather than a player's value. A schema
   * that is wrong cannot check anything, so the manifest carrying it has to be
   * refused rather than used.
   */
  const CASES: Array<[at: string, definition: unknown]> = [
    ["params.p", "an int please"],
    ["params.p", ["int"]],
    ["params.p.label", { type: "int" }],
    ["params.p.label", { type: "int", label: "" }],
    ["params.p.type", { type: "float", label: "P" }],
    ["params.p.type", { label: "P" }],
    ["params.p.values", { type: "enum", label: "P" }],
    ["params.p.values", { type: "enum", label: "P", values: [] }],
    ["params.p.values", { type: "enum", label: "P", values: ["a", 2] }],
    ["params.p.min", { type: "int", label: "P", min: 1.5 }],
    ["params.p.max", { type: "int", label: "P", max: "nine" }],
    ["params.p.default", { type: "int", label: "P", default: 0.5 }],
    // A range nothing can satisfy is a schema that refuses every value.
    ["params.p.min", { type: "int", label: "P", min: 10, max: 2 }],
    [
      "params.p.pattern",
      { type: "string", label: "P", pattern: "a".repeat(201) },
    ],
    ["params.p.pattern", { type: "string", label: "P", pattern: "[" }],
  ]

  for (const [at, definition] of CASES) {
    test(`${at}: ${JSON.stringify(definition)}`.slice(0, 90), () => {
      issueAt({ ...REFERENCE_MANIFEST, params: { p: definition } }, at)
    })
  }
})

describe("checking a value against its definition", () => {
  const schema: ParamSchema = {
    theme: { type: "color", label: "Theme", allowed: ["#000000"] },
    title: { type: "string", label: "Title", allowed: ["alpha", "beta"] },
    lives: { type: "int", label: "Lives", min: 1, max: 9 },
    music: { type: "bool", label: "Music" },
  }

  // Values a caller could really send, including the wrong types a schema
  // exists to refuse, so the cast is the point rather than a convenience.
  function issue(values: Record<string, unknown>, at: string): void {
    const issues = validateParams(schema, values as ParamValues)
    expect(
      issues.some((i) => i.at === at),
      `expected an issue at ${at}, got ${JSON.stringify(issues)}`,
    ).toBe(true)
  }

  test("a colour that is not a string", () => {
    issue(
      { theme: 0x000000, title: "alpha", lives: 1, music: true },
      "params.theme",
    )
  })

  test("a colour outside its allowed list", () => {
    issue(
      { theme: "#ffffff", title: "alpha", lives: 1, music: true },
      "params.theme",
    )
  })

  test("a string that is not a string", () => {
    issue({ theme: "#000000", title: 7, lives: 1, music: true }, "params.title")
  })

  test("a string outside its allowed list", () => {
    issue(
      { theme: "#000000", title: "gamma", lives: 1, music: true },
      "params.title",
    )
  })

  test("an int above its maximum", () => {
    issue(
      { theme: "#000000", title: "alpha", lives: 10, music: true },
      "params.lives",
    )
  })

  /**
   * A schema pattern that does not compile must refuse the value rather than
   * wave it through. The over-long case is already covered; this is the short
   * but unparseable one, which reaches the same null from the other side of
   * compilePattern and has to produce the same refusal.
   */
  test("a pattern that cannot compile refuses the value it cannot check", () => {
    const broken: ParamSchema = {
      slug: { type: "string", label: "Slug", pattern: "[unclosed" },
    }
    const issues = validateParams(broken, { slug: "anything" })
    expect(issues.map((i) => i.message)).toEqual([
      "cannot be checked: the schema pattern is unusable",
    ])
  })

  /**
   * compilePattern caches per schema and name. Asking twice has to give the
   * same answer: a cache that recompiled would be pointless, and one that
   * cached the wrong entry would check a value against another field's rule.
   */
  test("the compiled pattern is reused across calls", () => {
    const cached: ParamSchema = {
      slug: { type: "string", label: "Slug", pattern: "[a-z]+" },
      code: { type: "string", label: "Code", pattern: "[0-9]+" },
    }
    const first = validateParams(cached, { slug: "abc", code: "123" })
    const second = validateParams(cached, { slug: "abc", code: "123" })
    expect(first).toEqual([])
    expect(second).toEqual([])
    expect(
      validateParams(cached, { slug: "123", code: "abc" }).map((i) => i.at),
    ).toEqual(["params.slug", "params.code"])
  })
})
