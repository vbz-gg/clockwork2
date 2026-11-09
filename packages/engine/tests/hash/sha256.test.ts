import { describe, expect, test } from "bun:test"
import { createHash } from "node:crypto"
import { sha256Hex } from "../../src/hash/sha256"

function node(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex")
}

function filled(length: number, step = 31): Uint8Array {
  const out = new Uint8Array(length)
  for (let i = 0; i < length; i++) out[i] = (i * step + 7) & 0xff
  return out
}

/**
 * A second SHA-256, written differently on purpose: the length goes into the
 * padding as a BigInt, so it is right at any size. It is checked against
 * `node:crypto` below and then used as the oracle for the one thing node
 * cannot be asked about, the padding of a message longer than 512 MiB.
 */
function reference(message: Uint8Array, byteLength: bigint): string {
  const k: number[] = []
  const primes: number[] = []
  for (let n = 2; primes.length < 64; n++) {
    if (primes.every((p) => n % p !== 0)) primes.push(n)
  }
  const frac = (x: number) => Math.floor((x - Math.floor(x)) * 2 ** 32) >>> 0
  for (const p of primes) k.push(frac(Math.cbrt(p)))
  const h = primes.slice(0, 8).map((p) => frac(Math.sqrt(p)))
  const padded = new Uint8Array(Math.ceil((message.length + 9) / 64) * 64)
  padded.set(message)
  padded[message.length] = 0x80
  let bits = byteLength * 8n
  for (let i = padded.length - 1; i >= padded.length - 8; i--) {
    padded[i] = Number(bits & 0xffn)
    bits >>= 8n
  }
  const rotr = (x: number, n: number) => ((x >>> n) | (x << (32 - n))) >>> 0
  for (let at = 0; at < padded.length; at += 64) {
    const w: number[] = []
    for (let i = 0; i < 16; i++) {
      const view = new DataView(padded.buffer, at + i * 4, 4)
      w.push(view.getUint32(0))
    }
    for (let i = 16; i < 64; i++) {
      const a = w[i - 15] as number
      const b = w[i - 2] as number
      const s0 = rotr(a, 7) ^ rotr(a, 18) ^ (a >>> 3)
      const s1 = rotr(b, 17) ^ rotr(b, 19) ^ (b >>> 10)
      w.push(((w[i - 16] as number) + s0 + (w[i - 7] as number) + s1) >>> 0)
    }
    let [a, b, c, d, e, f, g, hh] = h as [
      number,
      number,
      number,
      number,
      number,
      number,
      number,
      number,
    ]
    for (let i = 0; i < 64; i++) {
      const t1 =
        (hh +
          (rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25)) +
          ((e & f) ^ (~e & g)) +
          (k[i] as number) +
          (w[i] as number)) >>>
        0
      const t2 =
        ((rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22)) +
          ((a & b) ^ (a & c) ^ (b & c))) >>>
        0
      hh = g
      g = f
      f = e
      e = (d + t1) >>> 0
      d = c
      c = b
      b = a
      a = (t1 + t2) >>> 0
    }
    const next = [a, b, c, d, e, f, g, hh]
    for (let i = 0; i < 8; i++) {
      h[i] = ((h[i] as number) + (next[i] as number)) >>> 0
    }
  }
  return h.map((x) => x.toString(16).padStart(8, "0")).join("")
}

describe("sha256Hex", () => {
  test("the FIPS 180-4 and NIST examples", () => {
    const ascii = (text: string) => new TextEncoder().encode(text)
    expect(sha256Hex(ascii(""))).toBe(
      "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
    )
    expect(sha256Hex(ascii("abc"))).toBe(
      "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
    )
    expect(
      sha256Hex(
        ascii("abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq"),
      ),
    ).toBe("248d6a61d20638b8e5c026930c3e6039a33ce45964ff2167f6ecedd419db06c1")
    expect(sha256Hex(new Uint8Array(1_000_000).fill(0x61))).toBe(
      "cdc76e5c9914fb9281a1c7e284d73e67f1809a48a497200e046d39ccc7112cd0",
    )
  })

  test("agrees with node:crypto on every length around a block edge", () => {
    // 55 is the last length whose padding fits one block, 56 the first that
    // needs two; 64 and 128 are whole blocks with nothing left over.
    for (let length = 0; length <= 300; length++) {
      const bytes = filled(length)
      expect(sha256Hex(bytes), `length ${length}`).toBe(node(bytes))
    }
  })

  test("agrees with node:crypto on a 1 MiB pack and on a view into a buffer", () => {
    const big = filled(1024 * 1024 + 13, 97)
    expect(sha256Hex(big)).toBe(node(big))
    const view = big.subarray(5, 70_005)
    expect(sha256Hex(view)).toBe(node(view))
  })

  test("the reference used below agrees with node:crypto", () => {
    for (const length of [0, 1, 55, 56, 64, 1000]) {
      const bytes = filled(length)
      expect(reference(bytes, BigInt(length))).toBe(node(bytes))
    }
  })

  test("the length is right past 512 MiB, where shifting it overflows", () => {
    // 2^29 bytes is 2^32 bits, the first count that needs the high word.
    const tail = filled(37)
    for (const counted of [
      2 ** 28,
      2 ** 29 - 1,
      2 ** 29,
      2 ** 29 + 37,
      2 ** 33 + 5,
    ]) {
      expect(sha256Hex(tail, counted), `${counted} bytes`).toBe(
        reference(tail, BigInt(counted)),
      )
    }
  })
})
