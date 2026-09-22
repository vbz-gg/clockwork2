/**
 * What a simulation may not name.
 *
 * Kept as data rather than as a regular expression so that the scanner can
 * report exactly which rule fired, and so the agent skill's reference can be
 * generated from the same list instead of drifting from it.
 */

/** Globals a simulation may not read at all. */
export const BANNED_GLOBALS: ReadonlyMap<string, string> = new Map([
  ["Date", "the wall clock; use the tick count"],
  ["performance", "the wall clock; use the tick count"],
  ["setTimeout", "a host timer; use the kernel Timer"],
  ["setInterval", "a host timer; use the kernel Timer"],
  ["setImmediate", "a host timer; use the kernel Timer"],
  ["requestAnimationFrame", "a host frame callback; the host owns the loop"],
  ["requestIdleCallback", "a host frame callback; the host owns the loop"],
  ["queueMicrotask", "asynchronous work; tick() is synchronous"],
  ["crypto", "a non-deterministic source; use Prng"],
  ["Intl", "locale-dependent"],
  ["WeakRef", "observable garbage collection"],
  ["FinalizationRegistry", "observable garbage collection"],
  ["structuredClone", "not specified closely enough to rely on"],
  ["Atomics", "shared memory"],
  ["WebAssembly", "outside the allow-list"],
  ["fetch", "the network"],
  ["XMLHttpRequest", "the network"],
  ["navigator", "a device signal"],
  ["localStorage", "host storage"],
  ["sessionStorage", "host storage"],
  ["indexedDB", "host storage"],
  ["document", "the DOM; the renderer is a separate module"],
  ["window", "the DOM; the renderer is a separate module"],
  ["Image", "loads over the network"],
])

/** Members that are banned wherever they are reached from. */
export const BANNED_MEMBERS: ReadonlyMap<string, string> = new Map([
  ["Math.random", "use Prng"],
  ["Math.pow", "use dmath.ipow or dmath.pow"],
  ["Math.sin", "use dmath.sin"],
  ["Math.cos", "use dmath.cos"],
  ["Math.tan", "use dmath.tan"],
  ["Math.asin", "use dmath.asin"],
  ["Math.acos", "use dmath.acos"],
  ["Math.atan", "use dmath.atan"],
  ["Math.atan2", "use dmath.atan2"],
  ["Math.exp", "use dmath.exp"],
  ["Math.expm1", "not specified"],
  ["Math.log", "use dmath.log"],
  ["Math.log2", "use dmath.log2"],
  ["Math.log10", "use dmath.log10"],
  ["Math.log1p", "not specified"],
  ["Math.cbrt", "not specified"],
  ["Math.hypot", "use dmath.hypot"],
  ["Math.sinh", "not specified"],
  ["Math.cosh", "not specified"],
  ["Math.tanh", "not specified"],
  ["Math.asinh", "not specified"],
  ["Math.acosh", "not specified"],
  ["Math.atanh", "not specified"],
  ["Date.now", "the wall clock; use the tick count"],
  ["performance.now", "the wall clock; use the tick count"],
  ["navigator.sendBeacon", "the network"],
  ["document.cookie", "host storage"],
  ["window.top", "the embedder"],
  ["window.parent", "the embedder"],
])

/** Property names that are banned however the object was reached. */
export const BANNED_PROPERTIES: ReadonlyMap<string, string> = new Map([
  ["toLocaleString", "locale-dependent; use a fixed format"],
  ["localeCompare", "locale-dependent; compare code units"],
  ["sendBeacon", "the network"],
])

/** Renderer packages a simulation must not import. */
export const BANNED_IMPORTS: readonly string[] = [
  "three",
  "pixi.js",
  "@pixi/",
  "babylonjs",
  "@babylonjs/",
  "phaser",
  "playcanvas",
  "matter-js",
  "cannon-es",
  "@dimforge/rapier2d",
  "@dimforge/rapier3d",
]
