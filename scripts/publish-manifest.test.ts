import { describe, expect, test } from "bun:test"
import {
  hasWorkspaceRange,
  type Manifest,
  resolveWorkspaceDeps,
} from "./publish-manifest"

const base: Manifest = {
  name: "@clockwork2/host-bridge",
  version: "0.2.0",
  dependencies: { "@clockwork2/kernel": "workspace:*", typescript: "5.9.3" },
  peerDependencies: { "pixi.js": "^8.0.0" },
}

describe("what gets published", () => {
  test("a workspace range becomes the version being published", () => {
    const out = resolveWorkspaceDeps(base, "0.2.0")
    expect(out.dependencies).toEqual({
      "@clockwork2/kernel": "0.2.0",
      typescript: "5.9.3",
    })
  })

  test("a third-party range is left exactly as written", () => {
    const out = resolveWorkspaceDeps(base, "0.2.0")
    expect(out.peerDependencies).toEqual({ "pixi.js": "^8.0.0" })
  })

  test("nothing else in the manifest is touched", () => {
    const out = resolveWorkspaceDeps(
      { ...base, exports: { ".": "./dist" } },
      "0.2.0",
    )
    expect(out.name).toBe("@clockwork2/host-bridge")
    expect(out.exports).toEqual({ ".": "./dist" })
  })

  test("a workspace range it does not understand throws rather than guessing", () => {
    // Silently publishing the wrong range is the failure this whole file
    // exists to prevent, so an unfamiliar one stops the release.
    expect(() =>
      resolveWorkspaceDeps(
        { name: "x", dependencies: { y: "workspace:^1.2.3" } },
        "0.2.0",
      ),
    ).toThrow(/cannot resolve/)
  })

  test("a package with no dependencies at all is fine", () => {
    expect(
      resolveWorkspaceDeps({ name: "@clockwork2/kernel" }, "0.2.0"),
    ).toEqual({
      name: "@clockwork2/kernel",
    })
  })

  test("hasWorkspaceRange sees them in both dependency fields", () => {
    expect(hasWorkspaceRange(base)).toBe(true)
    expect(hasWorkspaceRange(resolveWorkspaceDeps(base, "0.2.0"))).toBe(false)
    expect(hasWorkspaceRange({ peerDependencies: { a: "workspace:*" } })).toBe(
      true,
    )
  })
})
