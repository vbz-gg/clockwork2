/**
 * A pack reader for a test that calls a game's `init` by hand.
 *
 * Inside a session the kernel decides what a game may read at each step. A
 * unit test that drives `init`, `tick` and `restore` directly has no session,
 * so it hands the game this instead: it reads whatever it was given, and
 * refuses anything else with the code a session would use for an undeclared
 * pack. It checks no fingerprint, so it is for tests and nothing else.
 */

import type { PlainValue } from "../contract.js"
import { fail } from "../errors.js"
import { decodeJsonPack, type PackReader } from "../packs.js"

export function packReaderFor(
  packs: ReadonlyMap<string, Uint8Array> = new Map(),
): PackReader {
  const bytes = (path: string): Uint8Array => {
    const found = packs.get(path)
    if (found === undefined) {
      fail("E_PACK_UNDECLARED", {
        detail: `${path} was not given to this reader`,
      })
    }
    return found
  }
  return {
    open: (path) => bytes(path).slice(),
    json: (path): PlainValue => decodeJsonPack(bytes(path), path),
  }
}
