/**
 * Loading a game from a directory.
 *
 * "Freshly evaluated" is the part that matters. The platform evaluates a
 * module afresh per session rather than taking a fresh instance from one
 * evaluation, because a fresh instance does not reset a module-level counter -
 * which is exactly what a game with static entity ids relies on without
 * knowing it. A cache-busting query on the import is how that is done here.
 */

import {
  closeSync,
  existsSync,
  openSync,
  readFileSync,
  readSync,
  statSync,
} from "node:fs"
import { dirname, isAbsolute, join, resolve } from "node:path"
import {
  assertManifest,
  fail,
  type GameModule,
  type GameModuleSource,
  instantiate,
  logicPacks,
  type Manifest,
} from "../index.js"
import type { Subject } from "./types.js"

const ENTRY_NAMES = ["index.ts", "index.js", "index.mjs", "src/index.ts"]

export function findEntry(target: string): string {
  const full = isAbsolute(target) ? target : resolve(target)
  // A path straight to a file is the entry, whatever it is called.
  //
  // This asks statSync rather than `!existsSync(join(full, "."))`, which was
  // here before and never once fired: path.join normalises the "." away, so it
  // asked whether `full` exists twice over and answered false for a file and a
  // directory alike. The direct-file case was reaching the fallback below
  // instead, and the fallback returned the directory for a bundle with no
  // entry - so the message this ends with, the only one that names the
  // filenames looked for, was unreachable. A submitter who shipped no entry
  // file got `Cannot find module /path/to/bundle` from the import.
  if (existsSync(full) && statSync(full).isFile()) return full
  for (const name of ENTRY_NAMES) {
    const candidate = join(full, name)
    if (existsSync(candidate)) return candidate
  }
  fail("E_SUBJECT_LOAD", {
    detail: `no entry file at ${target}; looked for ${ENTRY_NAMES.join(", ")}`,
  })
}

interface Loaded {
  readonly default?: unknown
  readonly MANIFEST?: unknown
  readonly manifest?: unknown
  readonly [key: string]: unknown
}

function pickSource(loaded: Loaded): GameModuleSource {
  const candidate = loaded.default ?? loaded.createGame ?? loaded.Game
  if (candidate === undefined) {
    fail("E_SUBJECT_LOAD", {
      detail:
        "the entry has no default export; a bundle exports its GameModule, or a factory for one, as default",
    })
  }
  return candidate as GameModuleSource
}

/**
 * Reads each declared pack under `root`, at most one byte past its declared
 * size.
 *
 * Nothing is checked here: a pack that is missing is left out and one that is
 * wrong is read as it is, so that every check running the game reports it
 * with its own code. The read is bounded because a file far larger than its
 * declaration is either a mistake or an attack, and one extra byte is enough
 * for the kernel to refuse it as too large without the loader reading
 * gigabytes first. The manifest's path rules already keep every path inside
 * `root`.
 */
export function readPacks(
  root: string,
  manifest: Manifest,
): Map<string, Uint8Array> {
  const out = new Map<string, Uint8Array>()
  for (const pack of logicPacks(manifest.assets).values()) {
    const file = join(root, pack.path)
    if (!existsSync(file) || !statSync(file).isFile()) continue
    const limit = Math.min(statSync(file).size, pack.bytes + 1)
    const bytes = new Uint8Array(limit)
    const handle = openSync(file, "r")
    try {
      let read = 0
      while (read < limit) {
        const got = readSync(handle, bytes, read, limit - read, read)
        if (got === 0) break
        read += got
      }
      out.set(pack.path, read === limit ? bytes : bytes.subarray(0, read))
    } finally {
      closeSync(handle)
    }
  }
  return out
}

/**
 * Builds a Subject from a directory or entry file.
 *
 * Given a file, the root is the file's directory, so its packs and the files
 * the budgets check walks are found beside it.
 */
export async function loadSubject(
  target: string,
  options: {
    readonly config?: unknown
    /** The packs' bytes, instead of reading them from the bundle's directory. */
    readonly packs?: ReadonlyMap<string, Uint8Array>
  } = {},
): Promise<Subject> {
  const entry = findEntry(target)
  const full = isAbsolute(target) ? target : resolve(target)
  const root = statSync(full).isFile() ? dirname(full) : full

  let counter = 0
  const load = async (loadOptions?: {
    fresh?: boolean
  }): Promise<GameModule> => {
    const specifier =
      loadOptions?.fresh === true ? `${entry}?fresh=${counter++}` : entry
    const loaded = (await import(specifier)) as Loaded
    return instantiate(pickSource(loaded))
  }

  const loaded = (await import(entry)) as Loaded
  const first = instantiate(pickSource(loaded))
  const manifestJson = join(root, "manifest.json")
  const rawManifest =
    loaded.MANIFEST ??
    loaded.manifest ??
    first.manifest ??
    (existsSync(manifestJson)
      ? (JSON.parse(readFileSync(manifestJson, "utf8")) as unknown)
      : undefined)
  const manifest: Manifest = assertManifest(rawManifest)

  return {
    manifest,
    load,
    entry,
    root,
    packs: options.packs ?? readPacks(root, manifest),
    ...(options.config === undefined ? {} : { config: options.config }),
  }
}
