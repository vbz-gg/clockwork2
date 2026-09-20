import { describe, expect, test } from "bun:test"
import {
  assertManifest,
  mergeParamDefaults,
  type ParamSchema,
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
      schemaVersion: 2,
      id: "X",
      version: "one",
    })
    expect(issues.length).toBeGreaterThan(3)
  })

  test("identity and version", () => {
    issueAt({ ...REFERENCE_MANIFEST, schemaVersion: 2 }, "schemaVersion")
    issueAt({ ...REFERENCE_MANIFEST, id: "Has Capitals" }, "id")
    issueAt({ ...REFERENCE_MANIFEST, id: "x" }, "id")
    issueAt({ ...REFERENCE_MANIFEST, version: "1.0" }, "version")
    withoutIssues({ ...REFERENCE_MANIFEST, version: "2.10.3-beta.1" })
  })

  test("the session block", () => {
    const session = REFERENCE_MANIFEST.session
    issueAt(
      { ...REFERENCE_MANIFEST, session: { ...session, tickHz: 45 } },
      "session.tickHz",
    )
    issueAt(
      { ...REFERENCE_MANIFEST, session: { ...session, maxTicks: 0 } },
      "session.maxTicks",
    )
    issueAt(
      { ...REFERENCE_MANIFEST, session: { ...session, maxWallSeconds: -1 } },
      "session.maxWallSeconds",
    )
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
    issueAt({ ...REFERENCE_MANIFEST, tiePolicy: "coin-toss" }, "tiePolicy")
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
})
