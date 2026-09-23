/**
 * Manifest and parameter validation.
 *
 * It collects rather than throws, because a developer fixing a manifest wants
 * every problem at once, not the first one. `assertManifest` is the throwing
 * form for code that only cares whether it is usable.
 *
 * The parameter half is ported from game-base's `metaConfig`, with three
 * changes. Unknown keys in the supplied values are reported rather than
 * silently dropped, so a typo in a config is visible. A `pattern` is anchored
 * at both ends and capped in length, and compiled once per schema rather than
 * on every call, because the pattern comes from a submitted manifest and
 * `new RegExp(untrusted)` per validation is a denial-of-service surface. And
 * a missing value with no default is left out of the merged result rather than
 * set to `undefined`, which keeps the result canonically encodable.
 */

import { fail } from "../errors"
import type {
  Manifest,
  ParamDefinition,
  ParamSchema,
  ParamValues,
} from "./types"
import { TICK_RATES } from "./types"

export type Issue = {
  /** Dotted path into the document, for example `counters[1].direction`. */
  readonly at: string
  readonly message: string
}

const ID_PATTERN = /^[a-z0-9][a-z0-9-]{1,62}[a-z0-9]$/
const SEMVER_PATTERN = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z-.]+)?$/
const HEX_COLOR_PATTERN = /^#[0-9A-Fa-f]{6}$/
const SHA256_PATTERN = /^[0-9a-f]{64}$/
const MAX_PATTERN_LENGTH = 200

const patternCache = new WeakMap<ParamSchema, Map<string, RegExp | null>>()

function compilePattern(
  schema: ParamSchema,
  name: string,
  pattern: string,
): RegExp | null {
  let cache = patternCache.get(schema)
  if (cache === undefined) {
    cache = new Map()
    patternCache.set(schema, cache)
  }
  if (cache.has(name)) return cache.get(name) ?? null
  let compiled: RegExp | null = null
  if (pattern.length <= MAX_PATTERN_LENGTH) {
    try {
      compiled = new RegExp(`^(?:${pattern})$`)
    } catch {
      compiled = null
    }
  }
  cache.set(name, compiled)
  return compiled
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return false
  }
  const proto = Object.getPrototypeOf(value) as object | null
  return proto === Object.prototype || proto === null
}

function checkParamDefinition(
  issues: Issue[],
  at: string,
  definition: unknown,
): void {
  if (!isPlainObject(definition)) {
    issues.push({ at, message: "must be an object" })
    return
  }
  const type = definition.type
  if (typeof definition.label !== "string" || definition.label.length === 0) {
    issues.push({ at: `${at}.label`, message: "must be a non-empty string" })
  }
  switch (type) {
    case "color":
    case "string":
    case "enum":
    case "int":
    case "bool":
      break
    default:
      issues.push({
        at: `${at}.type`,
        message: 'must be one of "color", "string", "enum", "int", "bool"',
      })
      return
  }
  if (type === "enum") {
    const values = definition.values
    if (!Array.isArray(values) || values.length === 0) {
      issues.push({ at: `${at}.values`, message: "must be a non-empty array" })
    } else if (!values.every((v) => typeof v === "string")) {
      issues.push({ at: `${at}.values`, message: "must be all strings" })
    }
  }
  if (type === "int") {
    for (const key of ["min", "max", "default"] as const) {
      const value = definition[key]
      if (value !== undefined && !Number.isInteger(value)) {
        issues.push({ at: `${at}.${key}`, message: "must be a whole number" })
      }
    }
    const { min, max } = definition as { min?: number; max?: number }
    if (min !== undefined && max !== undefined && min > max) {
      issues.push({ at: `${at}.min`, message: `is above max (${max})` })
    }
  }
  if (type === "string" && typeof definition.pattern === "string") {
    if (definition.pattern.length > MAX_PATTERN_LENGTH) {
      issues.push({
        at: `${at}.pattern`,
        message: `must be at most ${MAX_PATTERN_LENGTH} characters`,
      })
    } else {
      try {
        new RegExp(definition.pattern)
      } catch {
        issues.push({
          at: `${at}.pattern`,
          message: "is not a valid expression",
        })
      }
    }
  }
}

/** Checks a set of supplied values against a schema. */
export function validateParams(
  schema: ParamSchema,
  values: ParamValues | null | undefined,
): Issue[] {
  const issues: Issue[] = []
  const supplied = values ?? {}

  for (const [name, definition] of Object.entries(schema)) {
    const at = `params.${name}`
    const value = (supplied as Record<string, unknown>)[name]
    if (value === undefined) {
      const hasDefault =
        "default" in definition && definition.default !== undefined
      if (definition.optional !== true && !hasDefault) {
        issues.push({ at, message: "is required" })
      }
      continue
    }
    checkValue(issues, at, name, schema, definition, value)
  }

  for (const name of Object.keys(supplied)) {
    if (!(name in schema)) {
      // game-base ignored these, so a typo in a config was invisible.
      issues.push({ at: `params.${name}`, message: "is not in the schema" })
    }
  }

  return issues
}

function checkValue(
  issues: Issue[],
  at: string,
  name: string,
  schema: ParamSchema,
  definition: ParamDefinition,
  value: unknown,
): void {
  switch (definition.type) {
    case "color": {
      if (typeof value !== "string") {
        issues.push({ at, message: "must be a string" })
        return
      }
      if (!HEX_COLOR_PATTERN.test(value)) {
        issues.push({ at, message: "must be a hex colour like #1a2b3c" })
      }
      if (
        definition.allowed !== undefined &&
        !definition.allowed.includes(value)
      ) {
        issues.push({
          at,
          message: `must be one of ${definition.allowed.join(", ")}`,
        })
      }
      return
    }
    case "string": {
      if (typeof value !== "string") {
        issues.push({ at, message: "must be a string" })
        return
      }
      if (
        definition.minLength !== undefined &&
        value.length < definition.minLength
      ) {
        issues.push({
          at,
          message: `must be at least ${definition.minLength} characters`,
        })
      }
      if (
        definition.maxLength !== undefined &&
        value.length > definition.maxLength
      ) {
        issues.push({
          at,
          message: `must be at most ${definition.maxLength} characters`,
        })
      }
      if (
        definition.allowed !== undefined &&
        !definition.allowed.includes(value)
      ) {
        issues.push({
          at,
          message: `must be one of ${definition.allowed.join(", ")}`,
        })
      }
      if (definition.pattern !== undefined) {
        const compiled = compilePattern(schema, name, definition.pattern)
        if (compiled === null) {
          issues.push({
            at,
            message: "cannot be checked: the schema pattern is unusable",
          })
        } else if (!compiled.test(value)) {
          issues.push({ at, message: `must match ${definition.pattern}` })
        }
      }
      return
    }
    case "enum": {
      if (typeof value !== "string" || !definition.values.includes(value)) {
        issues.push({
          at,
          message: `must be one of ${definition.values.join(", ")}`,
        })
      }
      return
    }
    case "int": {
      if (!Number.isInteger(value)) {
        issues.push({ at, message: "must be a whole number" })
        return
      }
      const asNumber = value as number
      if (definition.min !== undefined && asNumber < definition.min) {
        issues.push({ at, message: `must be at least ${definition.min}` })
      }
      if (definition.max !== undefined && asNumber > definition.max) {
        issues.push({ at, message: `must be at most ${definition.max}` })
      }
      return
    }
    default: {
      if (typeof value !== "boolean") {
        issues.push({ at, message: "must be true or false" })
      }
    }
  }
}

/**
 * Fills in defaults. A parameter with neither a value nor a default is left
 * out rather than set to undefined, so the result stays canonically
 * encodable and a snapshot holding it can be hashed.
 */
export function mergeParamDefaults(
  schema: ParamSchema,
  values: ParamValues | null | undefined,
): ParamValues {
  const merged: Record<string, string | number | boolean> = {}
  const supplied = (values ?? {}) as Record<string, unknown>
  for (const [name, definition] of Object.entries(schema)) {
    const value = supplied[name]
    if (value !== undefined) {
      merged[name] = value as string | number | boolean
      continue
    }
    if ("default" in definition && definition.default !== undefined) {
      merged[name] = definition.default
    }
  }
  return merged
}

/** Every problem with a manifest, in document order. */
export function validateManifest(value: unknown): Issue[] {
  const issues: Issue[] = []
  if (!isPlainObject(value)) {
    return [{ at: "", message: "must be an object" }]
  }
  const m = value as Record<string, unknown>

  if (m.schemaVersion !== 1) {
    issues.push({ at: "schemaVersion", message: "must be 1" })
  }
  if (typeof m.id !== "string" || !ID_PATTERN.test(m.id)) {
    issues.push({
      at: "id",
      message: "must be 3 to 64 lowercase letters, digits and hyphens",
    })
  }
  if (typeof m.version !== "string" || !SEMVER_PATTERN.test(m.version)) {
    issues.push({ at: "version", message: "must be a semantic version" })
  }
  if (typeof m.name !== "string" || m.name.length === 0) {
    issues.push({ at: "name", message: "must be a non-empty string" })
  }
  if (!isPlainObject(m.kernel) || typeof m.kernel.version !== "string") {
    issues.push({ at: "kernel.version", message: "must be a version string" })
  }

  const session = m.session
  if (!isPlainObject(session)) {
    issues.push({ at: "session", message: "must be an object" })
  } else {
    if (!TICK_RATES.includes(session.tickHz as never)) {
      issues.push({
        at: "session.tickHz",
        message: `must be one of ${TICK_RATES.join(", ")}`,
      })
    }
    if (
      !Number.isInteger(session.maxTicks) ||
      (session.maxTicks as number) <= 0
    ) {
      issues.push({
        at: "session.maxTicks",
        message: "must be a positive whole number",
      })
    }
    if (
      typeof session.maxWallSeconds !== "number" ||
      !Number.isFinite(session.maxWallSeconds) ||
      session.maxWallSeconds <= 0
    ) {
      issues.push({
        at: "session.maxWallSeconds",
        message: "must be a positive number",
      })
    }
    if (typeof session.hasEnding !== "boolean") {
      issues.push({ at: "session.hasEnding", message: "must be true or false" })
    }
  }

  const counters = m.counters
  const counterNames = new Set<string>()
  if (!Array.isArray(counters) || counters.length === 0) {
    issues.push({
      at: "counters",
      message: "must declare at least one counter",
    })
  } else {
    counters.forEach((counter: unknown, index: number) => {
      const at = `counters[${index}]`
      if (!isPlainObject(counter)) {
        issues.push({ at, message: "must be an object" })
        return
      }
      if (typeof counter.name !== "string" || counter.name.length === 0) {
        issues.push({ at: `${at}.name`, message: "must be a non-empty string" })
      } else if (counterNames.has(counter.name)) {
        issues.push({ at: `${at}.name`, message: "is declared twice" })
      } else {
        counterNames.add(counter.name)
      }
      if (counter.direction !== "up" && counter.direction !== "down") {
        issues.push({
          at: `${at}.direction`,
          message: 'must be "up" or "down"',
        })
      }
      if (typeof counter.monotonic !== "boolean") {
        issues.push({ at: `${at}.monotonic`, message: "must be true or false" })
      }
    })
  }

  const rankBy = m.rankBy
  if (!Array.isArray(rankBy) || rankBy.length === 0) {
    issues.push({ at: "rankBy", message: "must name at least one counter" })
  } else {
    rankBy.forEach((name: unknown, index: number) => {
      if (typeof name !== "string" || !counterNames.has(name)) {
        issues.push({
          at: `rankBy[${index}]`,
          message: `${JSON.stringify(name)} is not a declared counter`,
        })
      }
    })
  }

  if (!["shared", "earliest", "none"].includes(m.tiePolicy as string)) {
    issues.push({
      at: "tiePolicy",
      message: 'must be "shared", "earliest" or "none"',
    })
  }

  const inputs = m.inputs
  if (!isPlainObject(inputs) || !isPlainObject(inputs.map)) {
    issues.push({
      at: "inputs.map",
      message: "must be an object of action to bindings",
    })
  } else {
    for (const [action, bindings] of Object.entries(inputs.map)) {
      if (!Array.isArray(bindings) || bindings.length === 0) {
        issues.push({
          at: `inputs.map.${action}`,
          message: "must be a non-empty array of bindings",
        })
        continue
      }
      bindings.forEach((binding: unknown, index: number) => {
        const at = `inputs.map.${action}[${index}]`
        if (!isPlainObject(binding)) {
          issues.push({ at, message: "must be an object" })
          return
        }
        if (typeof binding.code !== "string" || binding.code.length === 0) {
          issues.push({
            at: `${at}.code`,
            message: "must be a non-empty string",
          })
        }
        if (
          !["key", "pointer", "touch", "gamepad", "virtual"].includes(
            binding.device as string,
          )
        ) {
          issues.push({ at: `${at}.device`, message: "is not a known device" })
        }
      })
    }

    // Which schemes exist is the host's table, not ours, so the name is only
    // checked for being a name. What is checkable here is that the binding
    // is coherent: a slot pointing at an action the game does not declare
    // draws a control that sends nothing, and the player finds out by
    // pressing it.
    const controls = inputs.controls
    if (controls !== undefined) {
      if (!isPlainObject(controls)) {
        issues.push({ at: "inputs.controls", message: "must be an object" })
      } else if (controls.mode !== "scheme" && controls.mode !== "custom") {
        issues.push({
          at: "inputs.controls.mode",
          message: 'must be "scheme" or "custom"',
        })
      } else if (controls.mode === "scheme") {
        if (
          typeof controls.scheme !== "string" ||
          controls.scheme.length === 0
        ) {
          issues.push({
            at: "inputs.controls.scheme",
            message: "must be a non-empty string",
          })
        }
        if (!isPlainObject(controls.bind)) {
          issues.push({
            at: "inputs.controls.bind",
            message: "must be an object of slot to action",
          })
        } else {
          const bound = Object.entries(controls.bind)
          if (bound.length === 0) {
            issues.push({
              at: "inputs.controls.bind",
              message: "must bind at least one slot",
            })
          }
          for (const [slot, action] of bound) {
            if (
              typeof action !== "string" ||
              !Object.hasOwn(inputs.map, action)
            ) {
              issues.push({
                at: `inputs.controls.bind.${slot}`,
                message: "must name an action declared in inputs.map",
              })
            }
          }
        }
      }
    }
  }

  const capabilities = m.capabilities
  if (!isPlainObject(capabilities)) {
    issues.push({ at: "capabilities", message: "must be an object" })
  } else {
    if (capabilities.deterministic !== true) {
      issues.push({
        at: "capabilities.deterministic",
        message: "must be true; there is no other kind of game here",
      })
    }
    if (capabilities.multiplayer !== false) {
      issues.push({
        at: "capabilities.multiplayer",
        message: "must be false in this release",
      })
    }
    if (typeof capabilities.renderer !== "string") {
      issues.push({ at: "capabilities.renderer", message: "must be a string" })
    }
    if (typeof capabilities.physics !== "string") {
      issues.push({
        at: "capabilities.physics",
        message: 'must be a string, "none" if unused',
      })
    }
  }

  if (m.params !== undefined) {
    if (!isPlainObject(m.params)) {
      issues.push({ at: "params", message: "must be an object" })
    } else {
      for (const [name, definition] of Object.entries(m.params)) {
        checkParamDefinition(issues, `params.${name}`, definition)
      }
    }
  }

  if (m.assets !== undefined) {
    if (!Array.isArray(m.assets)) {
      issues.push({ at: "assets", message: "must be an array" })
    } else {
      const paths = new Set<string>()
      m.assets.forEach((asset: unknown, index: number) => {
        const at = `assets[${index}]`
        if (!isPlainObject(asset)) {
          issues.push({ at, message: "must be an object" })
          return
        }
        if (typeof asset.path !== "string" || asset.path.length === 0) {
          issues.push({
            at: `${at}.path`,
            message: "must be a non-empty string",
          })
        } else if (paths.has(asset.path)) {
          issues.push({ at: `${at}.path`, message: "is declared twice" })
        } else {
          paths.add(asset.path)
        }
        if (
          typeof asset.sha256 !== "string" ||
          !SHA256_PATTERN.test(asset.sha256)
        ) {
          issues.push({
            at: `${at}.sha256`,
            message: "must be 64 lowercase hex digits",
          })
        }
        if (!Number.isInteger(asset.bytes) || (asset.bytes as number) < 0) {
          issues.push({
            at: `${at}.bytes`,
            message: "must be a whole number of bytes",
          })
        }
        if (typeof asset.requiredForSim !== "boolean") {
          issues.push({
            at: `${at}.requiredForSim`,
            message: "must be true or false",
          })
        }
        if (typeof asset.license !== "string" || asset.license.length === 0) {
          issues.push({ at: `${at}.license`, message: "must be stated" })
        }
      })
    }
  }

  return issues
}

/** The throwing form. */
export function assertManifest(value: unknown): Manifest {
  const issues = validateManifest(value)
  if (issues.length > 0) {
    fail("E_MANIFEST_INVALID", {
      detail: issues
        .map((issue) => `${issue.at || "<root>"}: ${issue.message}`)
        .join("; "),
    })
  }
  return value as Manifest
}
