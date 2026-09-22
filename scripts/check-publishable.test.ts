import { describe, expect, test } from "bun:test"
import {
  PUBLIC_PACKAGES,
  problemsWith,
  type Shipped,
} from "./check-publishable"

function shipped(over: Partial<Shipped> = {}): Shipped {
  return {
    name: "@clockwork2/engine",
    version: "0.1.0",
    dependencies: {},
    files: ["package.json", "README.md", "dist/index.js", "src/index.ts"],
    ...over,
  }
}

describe("what a tarball would do to a consumer", () => {
  test("a good package has nothing to say about it", () => {
    expect(problemsWith(shipped())).toEqual([])
  })

  test("an unrewritten workspace range is caught", () => {
    // The whole reason this file exists. npm ships the string as written and
    // the published version is then uninstallable by anyone, permanently.
    const problems = problemsWith(
      shipped({ dependencies: { "@clockwork2/engine": "workspace:*" } }),
    )
    expect(problems.join("\n")).toContain("no consumer can install")
  })

  test("a missing readme is caught, because npm drops it quietly", () => {
    const problems = problemsWith(
      shipped({ files: ["package.json", "dist/index.js"] }),
    )
    expect(problems.join("\n")).toContain("no README.md")
  })

  test("packing without a build is caught", () => {
    const problems = problemsWith(
      shipped({ files: ["package.json", "README.md", "src/index.ts"] }),
    )
    expect(problems.join("\n")).toContain("no dist")
  })

  test("a third-party dependency is left alone", () => {
    expect(
      problemsWith(shipped({ dependencies: { typescript: "5.9.3" } })),
    ).toEqual([])
  })

  test("the checker packs what publish.ts publishes", async () => {
    // Two files naming the same directory. When this was six packages they
    // held two lists that could drift apart; now it is one name, and it still
    // has to be the same name or the check measures a package nobody ships.
    const source = await Bun.file(
      new URL("./publish.ts", import.meta.url).pathname,
    ).text()
    for (const pkg of PUBLIC_PACKAGES) {
      expect(source).toContain(`packages/${pkg}`)
    }
  })
})
