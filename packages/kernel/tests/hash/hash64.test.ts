import { describe, expect, test } from "bun:test"
import { Hash64, hash64 } from "../../src/hash/hash64"

describe("hash64", () => {
  test("is 16 lowercase hex digits", () => {
    expect(hash64("anything")).toMatch(/^[0-9a-f]{16}$/)
  })

  test("is stable", () => {
    expect(hash64("clockwork2")).toBe(hash64("clockwork2"))
  })

  test("a one-character change moves most of the digest", () => {
    const a = BigInt(`0x${hash64("the quick brown fox")}`)
    const b = BigInt(`0x${hash64("the quick brown fox.")}`)
    let differing = 0
    let x = a ^ b
    while (x > 0n) {
      if (x & 1n) differing++
      x >>= 1n
    }
    // Not a strong avalanche claim, just that it is not a weak checksum.
    expect(differing).toBeGreaterThan(16)
  })

  test("length is part of the input", () => {
    expect(hash64("a")).not.toBe(hash64("a\u0000"))
    expect(hash64("")).not.toBe(hash64("\u0000"))
  })

  test("streaming in pieces equals hashing the whole", () => {
    const whole = new Hash64().update("abcdefghij").digest()
    const pieces = new Hash64()
      .update("abc")
      .update("de")
      .update("fghij")
      .digest()
    expect(pieces).toBe(whole)
  })

  test("digest does not end the hasher", () => {
    const h = new Hash64().update("a")
    const first = h.digest()
    expect(h.digest()).toBe(first)
    expect(h.update("b").digest()).not.toBe(first)
  })

  test("reset returns it to the empty state", () => {
    const h = new Hash64().update("x")
    expect(h.reset().digest()).toBe(new Hash64().digest())
  })

  test("updateNumber separates -0 from 0", () => {
    expect(new Hash64().updateNumber(-0).digest()).not.toBe(
      new Hash64().updateNumber(0).digest(),
    )
  })

  test("no collisions across a large mechanical corpus", () => {
    const seen = new Map<string, string>()
    for (let i = 0; i < 200_000; i++) {
      const text = `item-${i}`
      const digest = hash64(text)
      const previous = seen.get(digest)
      if (previous !== undefined) {
        throw new Error(
          `collision: ${previous} and ${text} both hash to ${digest}`,
        )
      }
      seen.set(digest, text)
    }
    expect(seen.size).toBe(200_000)
  })
})
