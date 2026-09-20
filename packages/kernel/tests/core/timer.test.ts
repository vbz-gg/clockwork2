import { describe, expect, test } from "bun:test"
import { Timer } from "../../src/timer"

function makeTimer(): { timer: Timer; fired: string[] } {
  const timer = new Timer()
  const fired: string[] = []
  timer.define("a", () => fired.push(`a@${timer.tick}`))
  timer.define("b", () => fired.push(`b@${timer.tick}`))
  return { timer, fired }
}

describe("Timer", () => {
  test("a one-shot fires once, on its tick", () => {
    const { timer, fired } = makeTimer()
    timer.after("a", 3)
    for (let i = 0; i < 6; i++) timer.advance()
    expect(fired).toEqual(["a@3"])
    expect(timer.size).toBe(0)
  })

  test("an interval fires on every multiple", () => {
    const { timer, fired } = makeTimer()
    timer.every("a", 2)
    for (let i = 0; i < 7; i++) timer.advance()
    expect(fired).toEqual(["a@2", "a@4", "a@6"])
  })

  test("two timers due on the same tick run in creation order", () => {
    const { timer, fired } = makeTimer()
    const second = timer.after("b", 5)
    timer.after("a", 5)
    for (let i = 0; i < 6; i++) timer.advance()
    // b was created first, so it runs first, whatever the names are.
    expect(fired).toEqual(["b@5", "a@5"])
    expect(timer.has(second)).toBe(false)
  })

  test("a zero delay means the next tick, not this one", () => {
    // Firing inside the pass that scheduled it is how a timer loop becomes
    // infinite. Clockwork 1 special-cased this for the same reason.
    const timer = new Timer()
    let runs = 0
    timer.define("again", () => {
      runs++
      if (runs < 5) timer.after("again", 0)
    })
    timer.after("again", 0)
    timer.advance()
    expect(runs).toBe(1)
    timer.advance()
    expect(runs).toBe(2)
  })

  test("an interval of zero is refused", () => {
    const { timer } = makeTimer()
    expect(() => timer.every("a", 0)).toThrow(/E_ARG_INVALID/)
    expect(() => timer.every("a", -1)).toThrow(/E_ARG_INVALID/)
    expect(() => timer.after("a", 1.5)).toThrow(/E_ARG_INVALID/)
  })

  test("an unknown handler is refused at scheduling time, not at firing time", () => {
    const { timer } = makeTimer()
    expect(() => timer.after("nope", 1)).toThrow(ReferenceError)
  })

  test("clear, pause and resume", () => {
    const { timer, fired } = makeTimer()
    const id = timer.every("a", 2)
    timer.advance()
    timer.advance()
    expect(fired.length).toBe(1)
    timer.pause(id)
    for (let i = 0; i < 4; i++) timer.advance()
    expect(fired.length).toBe(1)
    timer.resume(id)
    timer.advance()
    expect(fired.length).toBe(2)
    timer.clear(id)
    for (let i = 0; i < 4; i++) timer.advance()
    expect(fired.length).toBe(2)
  })

  test("a throwing handler is not swallowed", () => {
    // Clockwork 1 logged and carried on, so a broken timer became a game that
    // quietly did nothing.
    const timer = new Timer()
    timer.define("boom", () => {
      throw new Error("boom")
    })
    timer.after("boom", 1)
    expect(() => timer.advance()).toThrow("boom")
  })

  describe("state", () => {
    test("round trips through JSON and resumes identically", () => {
      const live = makeTimer()
      live.timer.every("a", 3)
      live.timer.after("b", 10)
      for (let i = 0; i < 5; i++) live.timer.advance()

      const state = JSON.parse(JSON.stringify(live.timer.exportState()))
      const restored = makeTimer()
      restored.timer.importState(state)

      for (let i = 0; i < 20; i++) {
        live.timer.advance()
        restored.timer.advance()
      }
      expect(restored.fired).toEqual(
        live.fired.slice(live.fired.length - restored.fired.length),
      )
      expect(restored.timer.exportState()).toEqual(live.timer.exportState())
    })

    test("a state naming a handler this module never defined is refused", () => {
      const { timer } = makeTimer()
      expect(() =>
        timer.importState({
          tick: 0,
          nextId: 2,
          entries: [
            { id: 1, name: "ghost", targetTick: 5, interval: 0, paused: false },
          ],
        }),
      ).toThrow(/E_RESTORE_MISMATCH/)
    })

    test("ids keep counting after a restore, so a new timer cannot collide", () => {
      const { timer } = makeTimer()
      timer.after("a", 5)
      timer.after("b", 5)
      const state = timer.exportState()
      const fresh = makeTimer()
      fresh.timer.importState(state)
      const id = fresh.timer.after("a", 1)
      expect(id).toBe(state.nextId)
    })
  })
})
