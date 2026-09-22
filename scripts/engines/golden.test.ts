import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { probeVectorIds } from "../../packages/engine/src/probe/index"
import { GOLDEN, parseGolden, readGolden } from "./golden"

const LF = [
  "# Cross-engine probe digests. Written by scripts/engines.ts --update.",
  "# A change here means the simulation changed. Say why in the commit body.",
  "prng/alea-next\t1e2a0b220c5dcade",
  "dmath/sin\ta0494e3ad2f1a9c4",
  "",
].join("\n")

describe("the golden parser", () => {
  test("reads a vector's digest", () => {
    expect(parseGolden(LF).get("prng/alea-next")).toBe("1e2a0b220c5dcade")
  })

  test("skips the comment header and the trailing blank line", () => {
    expect([...parseGolden(LF).keys()]).toEqual(["prng/alea-next", "dmath/sin"])
  })

  test("a CRLF file reads the same as an LF one", () => {
    // Git for Windows checks text out with CRLF unless told otherwise. Under
    // the old parser the carriage return stayed on the end of each digest and
    // every vector read as no longer matching - `scripts/engines.ts` exiting 1
    // and saying the simulation had changed on a commit that had not touched
    // it. Measured, not supposed: convert probe-golden.tsv and run it.
    const crlf = LF.replace(/\n/g, "\r\n")
    expect(crlf).not.toBe(LF)
    expect([...parseGolden(crlf)]).toEqual([...parseGolden(LF)])
  })

  test("a digest carries no carriage return", () => {
    for (const digest of parseGolden(LF.replace(/\n/g, "\r\n")).values()) {
      expect(digest).toMatch(/^[0-9a-f]+$/)
    }
  })

  test("the committed file covers every vector the probe runs", () => {
    const golden = readGolden()
    for (const id of probeVectorIds({ heavy: true })) {
      expect(golden.has(id), `${id} is missing from ${GOLDEN}`).toBe(true)
    }
  })

  test("the committed file has Unix line endings", () => {
    // `.gitattributes` pins it. Asserted here as well as in the kernel's own
    // golden test because this is the reader CI runs on Windows.
    expect(readFileSync(GOLDEN, "utf8")).not.toContain("\r")
  })
})
