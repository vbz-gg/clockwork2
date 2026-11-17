/**
 * Resolving the kernel from the game rather than from this guide.
 *
 * The guide ships inside the engine package, and an agent's tools install it
 * once and use it against many games, so its scripts cannot depend on the
 * packages sitting next to themselves. They load the kernel out of the game's
 * own `node_modules`, which also means a game pinned to an older kernel is
 * checked against that kernel and not against whatever copy of the engine the
 * guide was installed from.
 */

import { resolve } from "node:path"

export function resolveFrom<T>(
  specifier: string,
  fromDirectory: string,
): Promise<T> {
  const from = resolve(fromDirectory)
  let path: string
  try {
    path = Bun.resolveSync(specifier, from)
  } catch {
    throw new Error(
      `${specifier} is not installed in ${from}; run "bun install" in the game's directory`,
    )
  }
  return import(path) as Promise<T>
}
