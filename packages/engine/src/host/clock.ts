/**
 * Where the host's time comes from.
 *
 * It is an interface rather than a direct call to `performance.now` and
 * `requestAnimationFrame` for one reason: a determinism suite has to be able
 * to drive the loop at frame rates a real display cannot produce, and to do it
 * without waiting. A test that has to sleep to check a timing property is a
 * test that will eventually be flaky, and flake in a determinism suite is
 * worse than useless because it trains people to re-run it.
 */

export interface Scheduler {
  now(): number
  request(callback: (now: number) => void): number
  cancel(handle: number): void
}

/** The real one: `requestAnimationFrame` over `performance.now`. */
export function browserScheduler(): Scheduler {
  return {
    now: () => performance.now(),
    request: (callback) => requestAnimationFrame(callback),
    cancel: (handle) => {
      cancelAnimationFrame(handle)
    },
  }
}

/**
 * A scheduler a test drives by hand.
 *
 * Nothing waits. `advance(16.7)` moves the clock and runs whatever frame was
 * pending, so a ten-minute session at 5 frames a second takes milliseconds to
 * check.
 */
export class ManualScheduler implements Scheduler {
  private current = 0
  private pending: Array<{ handle: number; callback: (now: number) => void }> =
    []
  private nextHandle = 1

  now(): number {
    return this.current
  }

  request(callback: (now: number) => void): number {
    const handle = this.nextHandle++
    this.pending.push({ handle, callback })
    return handle
  }

  cancel(handle: number): void {
    this.pending = this.pending.filter((entry) => entry.handle !== handle)
  }

  /** Moves the clock forward and runs the frames that were waiting. */
  advance(ms: number): void {
    this.current += ms
    const due = this.pending
    this.pending = []
    for (const entry of due) entry.callback(this.current)
  }

  /** Runs `count` frames of `ms` each. */
  run(count: number, ms: number): void {
    for (let i = 0; i < count; i++) this.advance(ms)
  }

  get pendingCount(): number {
    return this.pending.length
  }
}
