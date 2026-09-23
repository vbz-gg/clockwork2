/**
 * Canonical encoding: one byte sequence per value, so that two runs that
 * computed the same state produce the same digest and two runs that did not
 * produce different ones.
 *
 * The rules, and why each one is there:
 *
 * - Object keys are sorted, by UTF-16 code unit, so insertion order cannot
 *   change a digest. Arrays and Maps keep their order, because order is part
 *   of their value.
 * - Integers are written as a 64-bit two's complement pattern and other
 *   numbers as their IEEE 754 bits, so no decimal formatting sits between the
 *   state and the hash.
 * - Negative zero is NOT normalised. `-0` and `0` are different states and a
 *   simulation that reaches one rather than the other has diverged.
 * - NaN, Infinity, undefined, functions, symbols, and class instances are
 *   refused rather than coerced. Each of them is a bug in the snapshot, and
 *   encoding them would hide it. NaN in particular has an unspecified payload,
 *   so it cannot be hashed meaningfully even in principle - and the difference
 *   is not theoretical: an invalid operation yields 0xFFF8000000000000 on x86
 *   and 0x7FF8000000000000 on arm64, so hashing a NaN would give an Apple
 *   Silicon player a different checkpoint from an x86 one and the replay would
 *   report a mismatch neither of them caused. Refusing it here is what stops
 *   that, which is why this rule is load-bearing rather than fastidious.
 * - Strings carry their length, so `{"ab": 1}` and `{"a": "b1"}` cannot
 *   collide through a delimiter.
 */

import { toBits } from "../bits.js"
import type { PlainValue } from "../contract.js"
import { ClockworkError } from "../errors.js"
import { Hash64 } from "./hash64.js"

/** Somewhere to write encoded tokens. */
export interface CanonicalSink {
  push(token: string): void
}

const OBJECT_PROTO = Object.getPrototypeOf({}) as object

function describe(value: unknown): string {
  if (value === undefined) return "undefined"
  if (typeof value === "function") return "function"
  if (typeof value === "symbol") return "symbol"
  if (typeof value === "bigint") return "bigint"
  if (typeof value === "number") {
    if (Number.isNaN(value)) return "NaN"
    return value > 0 ? "Infinity" : "-Infinity"
  }
  if (value !== null && typeof value === "object") {
    const name = (value as object).constructor?.name ?? "object"
    return `${name} instance`
  }
  return typeof value
}

function reject(value: unknown, path: string): never {
  throw new ClockworkError("E_CANONICAL_UNSUPPORTED", {
    detail: `${path || "<root>"} holds ${describe(value)}`,
  })
}

function writeNumber(sink: CanonicalSink, value: number, path: string): void {
  if (!Number.isFinite(value)) reject(value, path)
  // Object.is separates -0 from 0; an integer check alone would not.
  if (Number.isInteger(value) && !Object.is(value, -0)) {
    if (!Number.isSafeInteger(value)) {
      // Outside 53 bits an integer is no longer exactly representable, so two
      // different states can share a double. Write it as a float instead of
      // pretending the integer form is exact.
      sink.push(`d${toBits(value).toString(16).padStart(16, "0")}`)
      return
    }
    sink.push(
      `i${BigInt.asUintN(64, BigInt(value)).toString(16).padStart(16, "0")}`,
    )
    return
  }
  sink.push(`d${toBits(value).toString(16).padStart(16, "0")}`)
}

function writeString(sink: CanonicalSink, value: string): void {
  sink.push(`s${value.length}:`)
  sink.push(value)
}

function write(
  sink: CanonicalSink,
  value: unknown,
  path: string,
  seen: Set<object>,
): void {
  if (value === null) {
    sink.push("n")
    return
  }
  switch (typeof value) {
    case "boolean":
      sink.push(value ? "t" : "f")
      return
    case "number":
      writeNumber(sink, value, path)
      return
    case "string":
      writeString(sink, value)
      return
    case "object":
      break
    default:
      reject(value, path)
  }

  const object = value as object
  if (seen.has(object)) {
    throw new ClockworkError("E_CANONICAL_UNSUPPORTED", {
      detail: `${path || "<root>"} is part of a cycle`,
    })
  }
  seen.add(object)

  if (Array.isArray(object)) {
    sink.push(`a${object.length}:`)
    for (let i = 0; i < object.length; i++) {
      write(sink, object[i], `${path}[${i}]`, seen)
    }
    seen.delete(object)
    return
  }

  const proto = Object.getPrototypeOf(object) as object | null
  if (proto !== OBJECT_PROTO && proto !== null) reject(object, path)

  const keys = Object.keys(object).sort()
  sink.push(`o${keys.length}:`)
  for (const key of keys) {
    writeString(sink, key)
    write(
      sink,
      (object as Record<string, unknown>)[key],
      path === "" ? key : `${path}.${key}`,
      seen,
    )
  }
  seen.delete(object)
}

/** Encodes to a string. Useful for tests and for reporting a difference. */
export function encodeCanonical(value: PlainValue): string {
  const parts: string[] = []
  write(parts, value, "", new Set())
  return parts.join("")
}

/** Encodes straight into a hasher, so nothing large is built in memory. */
export function hashCanonical(value: PlainValue): string {
  const hasher = new Hash64()
  const sink: CanonicalSink = {
    push(token) {
      hasher.update(token)
    },
  }
  write(sink, value, "", new Set())
  return hasher.digest()
}
