/**
 * Where the pack fixture's two packs are served from, and a loader for them.
 *
 * The files are the engine's own test fixture, imported as URLs so the build
 * copies their bytes unchanged next to the pages; a transformed byte would be
 * a different fingerprint. `no-inline` keeps a small file from becoming a
 * data URL, because the point is that the frame fetches from its own address.
 *
 * `delayMs` holds back every demand pack, so the loop visibly has to wait for
 * one: a pack served from the same machine otherwise arrives before anyone
 * could tell the loop held.
 */

import type { Manifest } from "@clockwork2/engine"
import { fetchPackLoader, type PackLoader } from "@clockwork2/engine/host"
import level from "../../../packages/engine/fixtures/packs/data/level-2.json?url&no-inline"
import rules from "../../../packages/engine/fixtures/packs/data/rules.json?url&no-inline"
import { LEVEL, RULES } from "../../../packages/engine/fixtures/packs/index"

const URLS: Readonly<Record<string, string>> = {
  [RULES]: rules,
  [LEVEL]: level,
}

export function packLoader(manifest: Manifest, delayMs: number): PackLoader {
  const fetchPack = fetchPackLoader({
    manifest,
    url: (pack) => new URL(URLS[pack.path] as string, location.href).href,
  })
  return async (path) => {
    if (path === LEVEL && delayMs > 0) {
      await new Promise((resolve) => setTimeout(resolve, delayMs))
    }
    return fetchPack(path)
  }
}
