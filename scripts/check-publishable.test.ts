import { describe, expect, test } from "bun:test"
import {
  PUBLIC_PACKAGES,
  problemsWith,
  type Shipped,
} from "./check-publishable"

function shipped(over: Partial<Shipped> = {}): Shipped {
  return {
    name: "@clockwork2/host-bridge",
    version: "0.1.0",
    dependencies: { "@clockwork2/kernel": "0.1.0" },
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
      shipped({ dependencies: { "@clockwork2/kernel": "workspace:*" } }),
    )
    expect(problems.join("\n")).toContain("no consumer can install")
  })

  test("a sibling pinned to a different version is caught", () => {
    const problems = problemsWith(
      shipped({
        version: "0.2.0",
        dependencies: { "@clockwork2/kernel": "0.1.0" },
      }),
    )
    expect(problems.join("\n")).toContain("move together")
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
      problemsWith(
        shipped({
          dependencies: { "@clockwork2/kernel": "0.1.0", typescript: "5.9.3" },
        }),
      ),
    ).toEqual([])
  })

  test("the list matches what publish.ts actually publishes", async () => {
    // Two lists of the same packages in two files is one list too many, but
    // the publisher's order is a dependency order and this one is not, so they
    // stay separate and agree here instead.
    const source = await Bun.file(
      new URL("./publish.ts", import.meta.url).pathname,
    ).text()
    const inPublisher = [...source.matchAll(/^\s+"([a-z0-9-]+)",$/gm)].map(
      (match) => match[1] as string,
    )
    expect([...inPublisher].sort()).toEqual([...PUBLIC_PACKAGES].sort())
  })
})
