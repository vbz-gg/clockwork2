/**
 * Loading a game from a directory.
 *
 * "Freshly evaluated" is the part that matters. The platform evaluates a
 * module afresh per session rather than taking a fresh instance from one
 * evaluation, because a fresh instance does not reset a module-level counter -
 * which is exactly what a game with static entity ids relies on without
 * knowing it. A cache-busting query on the import is how that is done here.
 */

import { existsSync, readFileSync, statSync } from "node:fs"
import { isAbsolute, join, resolve } from "node:path"
import {
  assertManifest,
  fail,
  type GameModule,
  type GameModuleSource,
  instantiate,
  type Manifest,
} from "@clockwork2/kernel"
import type { Subject } from "./types"

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

/** Builds a Subject from a directory or entry file. */
export async function loadSubject(
  target: string,
  options: { readonly config?: unknown } = {},
): Promise<Subject> {
  const entry = findEntry(target)
  const root = isAbsolute(target) ? target : resolve(target)

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
    ...(options.config === undefined ? {} : { config: options.config }),
  }
}
