/**
 * Getting pack bytes to a session.
 *
 * The kernel decides when a pack may be read and checks every byte of it. All
 * a host does is fetch: start packs before the session is built, and demand
 * packs when the game's `prefetch` hint or its `packsNeeded()` asks. How long
 * that takes changes how long the loop waits and nothing else, which is why
 * nothing here needs to be careful about timing.
 *
 * Three sources sit behind one function type: an address the frame fetches
 * from, memory for a server cache or a test, and whatever a desktop shell
 * reads files with. This module has the first two.
 */

import {
  type AssetDeclaration,
  ClockworkError,
  type Effect,
  fail,
  isClockworkError,
  isStartPack,
  logicPacks,
  type Manifest,
  type PackBytes,
  prefetchPaths,
} from "../index.js"

/**
 * Fetches one pack by its manifest path.
 *
 * What it returns belongs to the host from then on, and the host copies it
 * before the kernel checks it or a worker receives it, so a loader may hand
 * back bytes it also keeps in a cache.
 */
export type PackLoader = (path: string) => Promise<PackBytes>

/** What a host is given to find packs with. */
export interface PackSupply {
  /** Packs already in hand, by path. Every start pack must be here. */
  readonly preloaded?: ReadonlyMap<string, PackBytes>
  /**
   * Fetches a pack a prefetch hint or `packsNeeded()` names. Left out, a
   * demand pack that is needed and not preloaded ends the session with
   * `E_PACK_NOT_DELIVERED` rather than holding the loop forever.
   */
  readonly loader?: PackLoader
}

/** Serves packs from memory: a server's cache, or a test. */
export function memoryPackLoader(
  packs: ReadonlyMap<string, PackBytes>,
): PackLoader {
  return async (path) => {
    const bytes = packs.get(path)
    if (bytes === undefined) {
      fail("E_PACK_NOT_DELIVERED", { detail: `${path} is not in this loader` })
    }
    return bytes
  }
}

export interface FetchPackLoaderOptions {
  /** The manifest whose packs this fetches. */
  readonly manifest: Manifest
  /**
   * Where a pack is fetched from. Packs are stored under their fingerprint,
   * so this is usually `(pack) => "/pack/" + pack.sha256`. It is built here,
   * from the manifest, because no frame message may carry a URL.
   */
  readonly url: (pack: AssetDeclaration) => string
  /** Aborts every fetch this loader starts. */
  readonly signal?: AbortSignal
  /** Stands in for the global `fetch`. */
  readonly fetch?: (input: string, init: RequestInit) => Promise<Response>
}

/**
 * Fetches packs over HTTP.
 *
 * Requests are `mode: "cors"` with no credentials, because a sandboxed frame
 * has an opaque origin and sends `Origin: null`; the server must answer with
 * `Access-Control-Allow-Origin: *`, on a 404 too.
 *
 * The body is counted as it arrives and abandoned once it passes the declared
 * size, so an oversized pack is refused without being downloaded whole.
 * `Content-Length` is not consulted: with compression it is the encoded size,
 * which can exceed the declared one for a pack that does not compress, and a
 * sandboxed frame cannot read `Content-Encoding` to tell.
 */
export function fetchPackLoader(options: FetchPackLoaderOptions): PackLoader {
  const declared = logicPacks(options.manifest.assets)
  const get =
    options.fetch ??
    ((input: string, init: RequestInit) => globalThis.fetch(input, init))
  return async (path) => {
    const pack = declared.get(path)
    if (pack === undefined) {
      fail("E_PACK_UNDECLARED", {
        detail: `${path} is not a pack this manifest declares`,
      })
    }
    let response: Response
    try {
      response = await get(options.url(pack), {
        mode: "cors",
        credentials: "omit",
        ...(options.signal === undefined ? {} : { signal: options.signal }),
      })
    } catch (error) {
      // A network failure, a CORS refusal and an abort all reject the same
      // way, with nothing a page may read about which it was.
      return fail("E_PACK_NOT_DELIVERED", {
        detail: `${path} could not be fetched: ${String(error)}`,
        cause: error,
      })
    }
    if (!response.ok) {
      fail("E_PACK_NOT_DELIVERED", {
        detail: `${path} answered ${response.status}`,
      })
    }
    return readBody(response, pack)
  }
}

async function readBody(
  response: Response,
  pack: AssetDeclaration,
): Promise<Uint8Array> {
  if (response.body === null) return new Uint8Array(0)
  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  for (;;) {
    let next: Awaited<ReturnType<typeof reader.read>>
    try {
      next = await reader.read()
    } catch (error) {
      return fail("E_PACK_NOT_DELIVERED", {
        detail: `${pack.path} stopped arriving: ${String(error)}`,
        cause: error,
      })
    }
    if (next.done) break
    total += next.value.byteLength
    if (total > pack.bytes) {
      // Cancelling tells the server to stop; whether it heard is not this
      // pack's concern any more.
      reader.cancel().catch(() => undefined)
      fail("E_PACK_TOO_LARGE", {
        detail: `${pack.path} passed ${pack.bytes} bytes, the size its manifest declares`,
      })
    }
    chunks.push(next.value)
  }
  const out = new Uint8Array(total)
  let at = 0
  for (const chunk of chunks) {
    out.set(chunk, at)
    at += chunk.byteLength
  }
  return out
}

/**
 * Calls a loader, always from a microtask and always as a rejection on
 * failure.
 *
 * A prefetch hint arrives while the session is stepping. A loader that threw
 * there, synchronously, would end a browser run at a tick where the server
 * replay goes on, so the call is pushed past the current step. Anything that
 * is not already a kernel error becomes `E_PACK_NOT_DELIVERED`, the code a
 * platform retries on.
 */
export async function loadPack(
  loader: PackLoader,
  path: string,
): Promise<PackBytes> {
  await Promise.resolve()
  try {
    return await loader(path)
  } catch (error) {
    if (isClockworkError(error)) throw error
    return fail("E_PACK_NOT_DELIVERED", {
      detail: `${path} could not be loaded: ${String(error)}`,
      cause: error,
    })
  }
}

/**
 * Loads the packs a session needs before it starts: the start packs, or
 * every pack the manifest declares when a host would rather never wait.
 */
export async function loadPacks(
  manifest: Manifest,
  loader: PackLoader,
  which: "start" | "all" = "start",
): Promise<Map<string, PackBytes>> {
  const wanted = [...logicPacks(manifest.assets).values()].filter(
    (pack) => which === "all" || isStartPack(pack),
  )
  const loaded = await Promise.all(
    wanted.map(
      async (pack) => [pack.path, await loadPack(loader, pack.path)] as const,
    ),
  )
  return new Map(loaded)
}

/**
 * The bytes as a buffer nobody else holds, exactly as long as the pack. What
 * a page transfers to a worker is detached on the page, so it must never be
 * a buffer a cache or a loader also holds, nor the larger buffer under a view.
 */
export function ownedBuffer(bytes: PackBytes): ArrayBuffer {
  const view = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes)
  const out = new Uint8Array(view.byteLength)
  out.set(view)
  return out.buffer
}

/**
 * The loads one host has in flight.
 *
 * A request is either a prefetch, which may fail quietly because the pack will
 * be asked for again when it is needed, or a need, whose failure ends the
 * session. A prefetch still in flight when the pack becomes needed is
 * promoted rather than started twice, and a prefetch for a pack the session
 * already has is not started at all, so a game that repeats its hint every
 * tick downloads the pack once. Once closed, every outcome is ignored, so a
 * fetch that settles after the run ended cannot report into it.
 */
export class PackRequests {
  private readonly inFlight = new Map<string, { needed: boolean }>()
  private closed = false

  constructor(
    private readonly loader: PackLoader | undefined,
    private readonly deliver: (path: string, bytes: PackBytes) => void,
    private readonly failed: (error: unknown) => void,
    /** Whether the session already has a pack, so a hint for it is skipped. */
    private readonly has: (path: string) => boolean,
  ) {}

  /** Starts loading what the tick's prefetch hints name. */
  prefetch(effects: readonly Effect[]): void {
    // The kernel has already checked every name a hint carries.
    for (const effect of effects) {
      for (const path of prefetchPaths(effect) ?? []) {
        this.request(path as string, false)
      }
    }
  }

  request(path: string, needed: boolean): void {
    if (this.closed) return
    if (!needed && this.has(path)) return
    const existing = this.inFlight.get(path)
    if (existing !== undefined) {
      if (needed) existing.needed = true
      return
    }
    if (this.loader === undefined) {
      if (needed) {
        this.failed(
          new ClockworkError("E_PACK_NOT_DELIVERED", {
            detail: `${path} is needed, and this host was given no loader to fetch it with`,
          }),
        )
      }
      return
    }
    const entry = { needed }
    this.inFlight.set(path, entry)
    loadPack(this.loader, path).then(
      (bytes) => {
        if (this.closed) return
        this.inFlight.delete(path)
        try {
          this.deliver(path, bytes)
        } catch (error) {
          if (entry.needed) this.failed(error)
        }
      },
      (error: unknown) => {
        if (this.closed) return
        this.inFlight.delete(path)
        if (entry.needed) this.failed(error)
      },
    )
  }

  close(): void {
    this.closed = true
    this.inFlight.clear()
  }
}
