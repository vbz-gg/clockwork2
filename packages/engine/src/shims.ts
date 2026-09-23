/**
 * Traps for the globals a simulation may not touch.
 *
 * Installed around `init` and `tick` and taken down afterwards, so a violation
 * throws where it happens, with the name of what was touched, rather than
 * showing up later as a replay that does not match.
 *
 * These are belt and braces alongside the static scan in
 * `@clockwork2/validate`. Neither is enough on its own: a scan cannot see an
 * aliased global, `sendBeacon`, `new Image().src` or a dynamic import, and a
 * trap cannot see a path that never runs. Clockwork 1 had neither, and one of
 * its shipped games used `Math.random()` in a timer, which was only noticed
 * when a run that nobody played was paid and ranked.
 *
 * The trap is a throwing getter rather than a throwing function, so that even
 * reading the binding fails. `typeof Date` inside a simulation is already a
 * sign that something is about to go wrong.
 */

import { ClockworkError } from "./errors.js"

interface Trap {
  readonly label: string
  readonly owner: object
  readonly key: string
}

function trap(owner: object | undefined, key: string, label: string): Trap[] {
  if (owner === undefined) return []
  return [{ label, owner, key }]
}

function buildTraps(): Trap[] {
  const g = globalThis as unknown as Record<string, unknown>
  return [
    ...trap(Math, "random", "Math.random"),
    ...trap(g, "Date", "Date"),
    ...trap(g, "performance", "performance"),
    ...trap(g, "setTimeout", "setTimeout"),
    ...trap(g, "setInterval", "setInterval"),
    ...trap(g, "setImmediate", "setImmediate"),
    ...trap(g, "requestAnimationFrame", "requestAnimationFrame"),
    ...trap(g, "requestIdleCallback", "requestIdleCallback"),
    ...trap(g, "queueMicrotask", "queueMicrotask"),
    ...trap(g, "crypto", "crypto"),
    ...trap(g, "Intl", "Intl"),
    ...trap(g, "WeakRef", "WeakRef"),
    ...trap(g, "FinalizationRegistry", "FinalizationRegistry"),
    ...trap(g, "structuredClone", "structuredClone"),
    ...trap(g, "Atomics", "Atomics"),
    ...trap(g, "WebAssembly", "WebAssembly"),
    ...trap(g, "fetch", "fetch"),
    ...trap(g, "XMLHttpRequest", "XMLHttpRequest"),
    ...trap(g, "sendBeacon", "sendBeacon"),
    // Present only in a browser, where the simulation runs in a worker and
    // should never see them. `trap` skips anything that is not there.
    ...trap(g, "document", "document"),
    ...trap(g, "window", "window"),
    ...trap(g, "localStorage", "localStorage"),
    ...trap(g, "sessionStorage", "sessionStorage"),
    ...trap(g, "indexedDB", "indexedDB"),
    ...trap(g, "navigator", "navigator"),
    ...trap(g, "Image", "Image"),
    ...trap(
      Number.prototype,
      "toLocaleString",
      "Number.prototype.toLocaleString",
    ),
    ...trap(
      Array.prototype,
      "toLocaleString",
      "Array.prototype.toLocaleString",
    ),
    ...trap(
      String.prototype,
      "localeCompare",
      "String.prototype.localeCompare",
    ),
    ...trap(Math, "pow", "Math.pow"),
  ]
}

interface Installed {
  readonly trap: Trap
  readonly descriptor: PropertyDescriptor
}

let depth = 0
let installed: Installed[] = []
let unshimmable: string[] = []

/**
 * Names the traps could not be installed on in this environment, because the
 * property is not configurable. Reported rather than hidden: the static scan
 * is what covers them.
 */
export function unshimmableApis(): readonly string[] {
  return unshimmable
}

export function shimsInstalled(): boolean {
  return depth > 0
}

export function installShims(): void {
  depth++
  if (depth > 1) return
  installed = []
  unshimmable = []
  for (const t of buildTraps()) {
    const descriptor = Object.getOwnPropertyDescriptor(t.owner, t.key)
    if (descriptor === undefined) continue
    if (descriptor.configurable !== true) {
      unshimmable.push(t.label)
      continue
    }
    try {
      Object.defineProperty(t.owner, t.key, {
        configurable: true,
        enumerable: descriptor.enumerable ?? false,
        get() {
          throw new ClockworkError("E_BANNED_API", { detail: t.label })
        },
        set() {
          throw new ClockworkError("E_BANNED_API", { detail: t.label })
        },
      })
      installed.push({ trap: t, descriptor })
    } catch {
      unshimmable.push(t.label)
    }
  }
}

export function uninstallShims(): void {
  if (depth === 0) return
  depth--
  if (depth > 0) return
  // Restore in reverse, so a property defined twice ends up as it started.
  for (let i = installed.length - 1; i >= 0; i--) {
    const entry = installed[i] as Installed
    Object.defineProperty(entry.trap.owner, entry.trap.key, entry.descriptor)
  }
  installed = []
}

/**
 * Runs `body` with the traps in place and takes them down afterwards, whatever
 * happens. Nested calls are counted, so a caller that already installed them
 * keeps them.
 */
export function withShims<T>(body: () => T): T {
  installShims()
  try {
    return body()
  } finally {
    uninstallShims()
  }
}
