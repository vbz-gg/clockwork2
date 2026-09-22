/**
 * Where the host's time comes from.
 *
 * The property worth pinning about `browserScheduler` is which clock it is
 * built on. A loop driven by a timer and `Date.now` instead of
 * requestAnimationFrame and `performance.now` still runs, and still looks fine
 * to a casual test, but it paces frames against a wall clock that the system
 * can step. That is the same reason AGENTS.md bans `Date` on the simulation
 * side, and the reason ManualScheduler exists at all.
 *
 * ManualScheduler is the one every other host test drives, so a fault in it
 * would not fail here - it would quietly weaken every timing test in the
 * package.
 */

import { afterEach, describe, expect, test } from "bun:test"
import { browserScheduler, ManualScheduler } from "../src/clock"

const restores: Array<() => void> = []
afterEach(() => {
  while (restores.length > 0) restores.pop()?.()
})

function install(name: string, value: unknown): void {
  const target = globalThis as unknown as Record<string, unknown>
  const had = name in target
  const saved = target[name]
  target[name] = value
  restores.push(() => {
    if (had) target[name] = saved
    else delete target[name]
  })
}

describe("browserScheduler", () => {
  test("reads the clock through performance.now", () => {
    install("performance", { now: () => 1234.5 })
    expect(browserScheduler().now()).toBe(1234.5)
  })

  test("asks for frames through requestAnimationFrame", () => {
    const asked: Array<(now: number) => void> = []
    install("requestAnimationFrame", (callback: (now: number) => void) => {
      asked.push(callback)
      return asked.length
    })
    const scheduler = browserScheduler()
    const handle = scheduler.request(() => undefined)
    expect(handle).toBe(1)
    expect(asked.length).toBe(1)
  })

  test("cancels through cancelAnimationFrame, passing the handle it was given", () => {
    // A cancel that dropped the handle would leave the old frame running
    // alongside the new one, and the loop would step twice per frame.
    const cancelled: number[] = []
    install("cancelAnimationFrame", (handle: number) => {
      cancelled.push(handle)
    })
    browserScheduler().cancel(7)
    expect(cancelled).toEqual([7])
  })

  test("cancel returns nothing, so it can be used as a statement", () => {
    install("cancelAnimationFrame", () => 99)
    expect(browserScheduler().cancel(1)).toBeUndefined()
  })
})

describe("ManualScheduler", () => {
  test("starts at zero and moves only when advanced", () => {
    const scheduler = new ManualScheduler()
    expect(scheduler.now()).toBe(0)
    scheduler.advance(16.7)
    expect(scheduler.now()).toBe(16.7)
  })

  test("runs a pending frame with the time it advanced to", () => {
    const scheduler = new ManualScheduler()
    const seen: number[] = []
    scheduler.request((now) => seen.push(now))
    scheduler.advance(16.7)
    expect(seen).toEqual([16.7])
  })

  /**
   * A frame is run once. A scheduler that kept the callback would run every
   * frame ever requested on every advance, and a loop that re-requests each
   * frame would grow without bound.
   */
  test("a frame runs once, not on every later advance", () => {
    const scheduler = new ManualScheduler()
    let runs = 0
    scheduler.request(() => runs++)
    scheduler.advance(10)
    scheduler.advance(10)
    scheduler.advance(10)
    expect(runs).toBe(1)
  })

  test("a frame requested from inside a frame waits for the next advance", () => {
    // Otherwise advance() would recurse until the stack ran out.
    const scheduler = new ManualScheduler()
    const seen: number[] = []
    const again = (now: number): void => {
      seen.push(now)
      scheduler.request(again)
    }
    scheduler.request(again)
    scheduler.advance(10)
    expect(seen).toEqual([10])
    scheduler.advance(10)
    expect(seen).toEqual([10, 20])
  })

  test("cancel drops exactly one pending frame", () => {
    const scheduler = new ManualScheduler()
    const seen: string[] = []
    scheduler.request(() => seen.push("a"))
    const b = scheduler.request(() => seen.push("b"))
    scheduler.request(() => seen.push("c"))
    expect(scheduler.pendingCount).toBe(3)
    scheduler.cancel(b)
    expect(scheduler.pendingCount).toBe(2)
    scheduler.advance(1)
    expect(seen).toEqual(["a", "c"])
  })

  test("cancelling a handle that is not pending changes nothing", () => {
    const scheduler = new ManualScheduler()
    scheduler.request(() => undefined)
    scheduler.cancel(999)
    expect(scheduler.pendingCount).toBe(1)
  })

  test("handles are not reused after a cancel", () => {
    // A reused handle would let a cancel of the old frame drop the new one.
    const scheduler = new ManualScheduler()
    const first = scheduler.request(() => undefined)
    scheduler.cancel(first)
    expect(scheduler.request(() => undefined)).not.toBe(first)
  })

  test("run() is count advances of ms each", () => {
    const scheduler = new ManualScheduler()
    const seen: number[] = []
    const again = (now: number): void => {
      seen.push(now)
      scheduler.request(again)
    }
    scheduler.request(again)
    scheduler.run(4, 25)
    expect(scheduler.now()).toBe(100)
    expect(seen).toEqual([25, 50, 75, 100])
  })

  test("advancing with nothing pending just moves the clock", () => {
    const scheduler = new ManualScheduler()
    expect(() => scheduler.run(3, 10)).not.toThrow()
    expect(scheduler.now()).toBe(30)
    expect(scheduler.pendingCount).toBe(0)
  })
})
