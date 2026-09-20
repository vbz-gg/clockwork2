import { describe, expect, test } from "bun:test"
import { toBitsHex } from "../../src/bits"
import { encodeCanonical } from "../../src/hash/canonical"
import { Prng, type PrngState } from "../../src/prng/index"

describe("Prng", () => {
  test("the same seed gives the same stream", () => {
    const a = new Prng("seed")
    const b = new Prng("seed")
    for (let i = 0; i < 10_000; i++) {
      expect(toBitsHex(a.random())).toBe(toBitsHex(b.random()))
    }
  })

  test("different seeds diverge immediately", () => {
    expect(new Prng("a").random()).not.toBe(new Prng("b").random())
  })

  test("there is no unseeded path", () => {
    expect(() => new Prng("")).toThrow(/E_SEED_REQUIRED/)
    expect(() => new Prng(undefined as unknown as string)).toThrow(
      /E_SEED_REQUIRED/,
    )
  })

  test("randomInt covers both ends and nothing outside", () => {
    const rng = new Prng("ints")
    const seen = new Set<number>()
    for (let i = 0; i < 100_000; i++) {
      const v = rng.randomInt(3, 7)
      expect(Number.isInteger(v)).toBe(true)
      expect(v >= 3 && v <= 7).toBe(true)
      seen.add(v)
    }
    expect([...seen].sort((x, y) => x - y)).toEqual([3, 4, 5, 6, 7])
  })

  test("randomFloat stays in range", () => {
    const rng = new Prng("floats")
    for (let i = 0; i < 50_000; i++) {
      const v = rng.randomFloat(-2.5, 7.5)
      expect(v >= -2.5 && v < 7.5).toBe(true)
    }
  })

  test("randomBoolean honours its threshold", () => {
    const rng = new Prng("bools")
    let hits = 0
    for (let i = 0; i < 100_000; i++) if (rng.randomBoolean(0.25)) hits++
    expect(Math.abs(hits / 100_000 - 0.25) < 0.01).toBe(true)
    const always = new Prng("x")
    for (let i = 0; i < 100; i++) expect(always.randomBoolean(1)).toBe(true)
    const never = new Prng("y")
    for (let i = 0; i < 100; i++) expect(never.randomBoolean(0)).toBe(false)
  })

  test("randomChoice refuses an empty list rather than returning undefined", () => {
    expect(() => new Prng("c").randomChoice([])).toThrow(RangeError)
  })

  test("shuffle is a permutation and draws a fixed number of times", () => {
    const rng = new Prng("shuffle")
    const source = Array.from({ length: 50 }, (_, i) => i)
    const shuffled = rng.shuffle([...source])
    expect([...shuffled].sort((a, b) => a - b)).toEqual(source)
    expect(shuffled).not.toEqual(source)

    // The draw count is part of the contract: a caller that shuffles then
    // draws must land on the same value every run.
    const a = new Prng("count")
    a.shuffle(Array.from({ length: 10 }, (_, i) => i))
    const afterShuffle = a.random()
    const b = new Prng("count")
    for (let i = 0; i < 9; i++) b.random()
    expect(toBitsHex(b.random())).toBe(toBitsHex(afterShuffle))
  })

  describe("sub-streams", () => {
    test("drawing from a child never moves the parent", () => {
      const withChild = new Prng("s")
      const child = withChild.stream("effects")
      for (let i = 0; i < 100; i++) child.random()
      const after = [withChild.random(), withChild.random()]

      const alone = new Prng("s")
      expect(after.map(toBitsHex)).toEqual(
        [alone.random(), alone.random()].map(toBitsHex),
      )
    })

    test("drawing from the parent never moves a child", () => {
      const p = new Prng("s")
      for (let i = 0; i < 100; i++) p.random()
      const late = p.stream("effects").random()

      const q = new Prng("s")
      expect(toBitsHex(q.stream("effects").random())).toBe(toBitsHex(late))
    })

    test("two labels give two different streams", () => {
      const p = new Prng("s")
      expect(p.stream("a").random()).not.toBe(p.stream("b").random())
    })

    test("a label is memoised, not recreated", () => {
      const p = new Prng("s")
      expect(p.stream("a")).toBe(p.stream("a"))
    })

    test("labels cannot collide by concatenation", () => {
      const p = new Prng("s")
      // "a" + "bc" must not land on the same seed as "ab" + "c".
      expect(p.stream("a").stream("bc").random()).not.toBe(
        p.stream("ab").stream("c").random(),
      )
    })
  })

  describe("state", () => {
    test("exports plain data a snapshot can hold", () => {
      const p = new Prng("s")
      p.stream("fx").random()
      p.random()
      const state = p.exportState()
      expect(() => encodeCanonical(state as unknown as PrngState)).not.toThrow()
      expect(JSON.parse(JSON.stringify(state))).toEqual(state)
    })

    test("restores the parent and every child", () => {
      const live = new Prng("s")
      live.stream("fx").random()
      live.stream("ai").random()
      live.random()
      const state = live.exportState()

      const restored = new Prng("s")
      restored.importState(state)
      for (let i = 0; i < 100; i++) {
        expect(toBitsHex(restored.random())).toBe(toBitsHex(live.random()))
        expect(toBitsHex(restored.stream("fx").random())).toBe(
          toBitsHex(live.stream("fx").random()),
        )
        expect(toBitsHex(restored.stream("ai").random())).toBe(
          toBitsHex(live.stream("ai").random()),
        )
      }
    })

    test("a sub-stream reached for after the snapshot is still the right one", () => {
      // The failure this catches is invisible in the snapshot, which compares
      // equal, and shows up minutes later as a replay that does not match: a
      // child created after the snapshot is seeded from its parent's seed, so
      // restoring positions alone is not enough.
      const live = new Prng("original")
      live.random()
      const state = JSON.parse(JSON.stringify(live.exportState())) as PrngState

      // Restored into a generator built with a different seed, which is what
      // happens when a game's restore path constructs one before importing.
      const restored = new Prng("something-else")
      restored.importState(state)
      expect(restored.seed).toBe("original")

      for (const label of ["walls", "loot", "fx"]) {
        expect(toBitsHex(restored.stream(label).random()), label).toBe(
          toBitsHex(live.stream(label).random()),
        )
      }
    })

    test("restores a child the fresh instance has not reached yet", () => {
      // This is the case that matters: the validator restores into a module
      // that has never touched the sub-stream.
      const live = new Prng("s")
      for (let i = 0; i < 10; i++) live.stream("fx").random()
      const state = live.exportState()

      const fresh = new Prng("s")
      fresh.importState(state)
      expect(toBitsHex(fresh.stream("fx").random())).toBe(
        toBitsHex(live.stream("fx").random()),
      )
    })

    test("the export is stable whichever sub-stream was used first", () => {
      const a = new Prng("s")
      a.stream("z").random()
      a.stream("a").random()
      const b = new Prng("s")
      b.stream("a").random()
      b.stream("z").random()
      expect(encodeCanonical(a.exportState() as unknown as PrngState)).toBe(
        encodeCanonical(b.exportState() as unknown as PrngState),
      )
    })

    test("reset goes back to the start, children included", () => {
      const p = new Prng("s")
      const first = p.random()
      const childFirst = p.stream("fx").random()
      for (let i = 0; i < 50; i++) {
        p.random()
        p.stream("fx").random()
      }
      p.reset()
      expect(toBitsHex(p.random())).toBe(toBitsHex(first))
      expect(toBitsHex(p.stream("fx").random())).toBe(toBitsHex(childFirst))
    })
  })
})
