import { describe, expect, test } from "bun:test"
import {
  BEARING_PATTERNS,
  bearingFiles,
  checkCommitMessage,
  EXAMPLES,
  effectiveMessage,
  findTrailerValue,
  isBareValue,
  isExemptCommit,
  MAX_TRAILER_LINE,
  MIN_VALUE_LENGTH,
  summarize,
  TRAILER,
} from "./check-docs-updated"

const BEARING = ["packages/kernel/src/loop.ts"]
const REAL = `${TRAILER}: re-read engine.md on the loop; still accurate`

function commit(subject: string, ...rest: string[]): string {
  return [subject, "", ...rest].join("\n")
}

describe("bearing paths", () => {
  test("a source change is bearing", () => {
    expect(bearingFiles(BEARING)).toEqual(BEARING)
  })

  test("every documented surface is covered", () => {
    const covered = [
      "packages/kernel/src/errors.ts",
      "demo/src/game/snake.ts",
      "e2e/specs/00-smoke.spec.ts",
      "scripts/engines.ts",
      "skill/platform-game/SKILL.md",
      "docs/engine.md",
      "README.md",
      "package.json",
      "tsconfig.base.json",
      "biome.json",
      ".github/workflows/ci.yml",
    ]
    expect(bearingFiles(covered)).toEqual(covered)
  })

  test("a file that describes nothing else is not bearing", () => {
    expect(
      bearingFiles([
        "AGENTS.md",
        "CLAUDE.md",
        "LICENSE",
        "NOTICE",
        ".husky/commit-msg",
        ".gitignore",
      ]),
    ).toEqual([])
  })

  test("README.md is matched exactly, not as a prefix", () => {
    // Without the `$`, a template's own README would demand the trailer for
    // the root one's reasons.
    expect(bearingFiles(["README.md.bak"])).toEqual([])
    expect(BEARING_PATTERNS.length).toBeGreaterThan(8)
  })
})

describe("the message git records", () => {
  test("comment lines are dropped", () => {
    const raw = "fix: a thing\n# Please enter the commit message\n#\n"
    expect(effectiveMessage(raw)).toBe("fix: a thing")
  })

  test("everything below the scissors line is dropped", () => {
    const raw = [
      "fix: a thing",
      "# ------------------------ >8 ------------------------",
      `${TRAILER}: this is in the diff, not the message`,
    ].join("\n")
    expect(findTrailerValue(effectiveMessage(raw))).toBeNull()
  })
})

describe("exemptions", () => {
  test.each([
    "Merge branch 'main' into feature",
    'Revert "feat: a thing"',
    "fixup! feat: a thing",
    "squash! feat: a thing",
    "amend! feat: a thing",
    "chore(release): 0.1.1",
  ])("%s needs no trailer", (subject) => {
    expect(isExemptCommit(subject)).toBe(true)
    expect(checkCommitMessage(subject, BEARING).ok).toBe(true)
  })

  test("an ordinary subject is not exempt", () => {
    expect(isExemptCommit("feat: add a thing")).toBe(false)
  })

  test("a release commit staging every bumped manifest passes", () => {
    // commit-and-tag-version writes this commit with no editor, so a trailer
    // cannot be added to it and --no-verify is banned.
    const staged = [
      "package.json",
      "packages/kernel/package.json",
      "CHANGELOG.md",
    ]
    expect(checkCommitMessage("chore(release): 0.2.0", staged).ok).toBe(true)
  })
})

describe("the gate", () => {
  test("a bearing change with no trailer is rejected", () => {
    const result = checkCommitMessage(commit("feat: a thing"), BEARING)
    expect(result.ok).toBe(false)
    expect(result.error).toContain(TRAILER)
    expect(result.error).toContain("packages/kernel/src/loop.ts")
  })

  test("a bearing change with a real trailer passes", () => {
    expect(checkCommitMessage(commit("feat: a thing", REAL), BEARING).ok).toBe(
      true,
    )
  })

  test("a non-bearing change needs no trailer", () => {
    expect(checkCommitMessage(commit("docs: agents"), ["AGENTS.md"]).ok).toBe(
      true,
    )
  })

  test("a commit staging nothing needs no trailer", () => {
    expect(checkCommitMessage(commit("feat: a thing"), []).ok).toBe(true)
  })

  test.each(["yes", "n/a", "done", "ok", "checked", "-", "checked!"])(
    "%s is a rubber stamp, not a record",
    (value) => {
      const result = checkCommitMessage(
        commit("feat: a thing", `${TRAILER}: ${value}`),
        BEARING,
      )
      expect(result.ok).toBe(false)
      expect(result.error).toContain("records nothing")
    },
  )

  test("the floor is what catches a stamp the list does not name", () => {
    // "checked!" is in no list; only the length rule refuses it.
    expect(isBareValue("checked!")).toBe(true)
    expect("checked!".length).toBeLessThan(MIN_VALUE_LENGTH)
  })

  test("the trailer is found anywhere in the body", () => {
    const message = commit("feat: a thing", REAL, "", "Co-authored-by: A <a@b>")
    expect(checkCommitMessage(message, BEARING).ok).toBe(true)
  })

  test("the trailer name is matched case-insensitively", () => {
    expect(
      findTrailerValue("docs-updated: re-read engine.md on the loop"),
    ).toBe("re-read engine.md on the loop")
  })
})

describe("rejection text", () => {
  test("one bearing file is named, the rest counted", () => {
    expect(summarize(["a.ts"])).toBe("a.ts")
    expect(summarize(["a.ts", "b.ts", "c.ts"])).toBe("a.ts and 2 more")
  })

  test("every example fits commitlint's line cap", () => {
    // config-conventional caps a body or footer line at 100 columns, so an
    // example a reader copies has to arrive under it.
    for (const example of EXAMPLES) {
      expect(example.length).toBeLessThanOrEqual(MAX_TRAILER_LINE)
    }
  })

  test("every example passes the gate it illustrates", () => {
    for (const example of EXAMPLES) {
      expect(
        checkCommitMessage(commit("feat: a thing", example), BEARING).ok,
      ).toBe(true)
    }
  })
})
