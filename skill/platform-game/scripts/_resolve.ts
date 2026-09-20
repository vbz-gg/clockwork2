/**
 * Resolving the kernel from the game rather than from this skill.
 *
 * A skill is installed once and used against many projects, so its scripts
 * cannot depend on packages sitting next to themselves. They load the kernel
 * out of the game's own `node_modules`, which also means a game pinned to an
 * older kernel is checked against that kernel and not against whatever the
 * skill was installed beside.
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
