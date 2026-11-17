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

import { TIE_POLICIES, type TiePolicy } from "../counters.js"
import { fail } from "../errors.js"
import type {
  Manifest,
  ParamDefinition,
  ParamSchema,
  ParamValues,
} from "./types.js"
import { MANIFEST_FORMAT, TICK_RATES } from "./types.js"

export type Issue = {
  /** Dotted path into the document, for example `counters[1].direction`. */
  readonly at: string
  readonly message: string
}

const ID_PATTERN = /^[a-z0-9][a-z0-9-]{1,62}[a-z0-9]$/
const SEMVER_PATTERN = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z-.]+)?$/
const HEX_COLOR_PATTERN = /^#[0-9A-Fa-f]{6}$/
const SHA256_PATTERN = /^[0-9a-f]{64}$/
/**
 * An asset path is a relative path built from ASCII letters, digits, `.`,
 * `_`, `-` and `/`, with no empty, `.` or `..` segment.
 *
 * An allow-list, because the checker reads each path under the bundle's
 * directory and a host builds a URL from it. A deny-list for `..` and a
 * leading `/` misses `%2e%2e`, which a URL parser turns back into `..`, and
 * misses `?`, `#`, a drive letter, a backslash and a NUL, each of which
 * changes what is read or fetched.
 */
const ASSET_PATH_PATTERN = /^[A-Za-z0-9._-]+(?:\/[A-Za-z0-9._-]+)*$/
const ASSET_LOADS = new Set(["start", "demand"])
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

/**
 * The config a platform serves a ranked or practice run: every parameter the
 * manifest declares, at its default. A player never supplies one, because a
 * replay plays the recording's config, so a config the player chose would be
 * replayed and agree with itself. The conformance checks play this too, so
 * what they check is what a session plays.
 *
 * An optional parameter with no default is left out, as `mergeParamDefaults`
 * leaves it. What comes back always passes `validateParams`.
 *
 * @throws E_MANIFEST_INVALID naming every parameter that is required and has
 *   no default, which no config can be served without, and every default its
 *   own definition refuses
 */
export function servedConfig(manifest: Manifest): ParamValues {
  const schema = manifest.params ?? {}
  const served = mergeParamDefaults(schema, null)
  const unserved = new Set(
    Object.entries(schema)
      .filter(([name, definition]) => {
        return definition.optional !== true && served[name] === undefined
      })
      .map(([name]) => `params.${name}`),
  )
  const problems = [
    ...[...unserved].map(
      (at) =>
        `${at} is required and has no default, so a platform cannot serve it`,
    ),
    // A default the parameter's own definition refuses: out of its range,
    // not one of its values, or the wrong type.
    ...validateParams(schema, served)
      .filter((issue) => !unserved.has(issue.at))
      .map((issue) => `${issue.at}: its default ${issue.message}`),
  ]
  if (problems.length > 0) {
    fail("E_MANIFEST_INVALID", { detail: problems.join("; ") })
  }
  return served
}

/** A declared input's name: what a recorded input carries as its `code`. */
const INPUT_NAME = /^[a-z][a-zA-Z0-9]*$/
/** Enough for any game; a manifest with more is declaring a stream, not inputs. */
export const MAX_DECLARED_INPUTS = 64
/** A declared bound fits a 32-bit integer, which every engine stores exactly. */
const INPUT_BOUND = 0x7fffffff
const INPUT_FIELDS = new Set(["min", "max", "label"])

/**
 * The inputs a game records, by name and range. A format 1 binding table is
 * refused by name, so a manifest written for the old schema says what to
 * change rather than failing on a field it never heard of.
 */
function checkInputDeclarations(inputs: unknown, issues: Issue[]): void {
  if (!isPlainObject(inputs)) {
    issues.push({
      at: "inputs",
      message: "must be an object of input name to { min, max }",
    })
    return
  }
  const names = Object.keys(inputs)
  if (names.length > MAX_DECLARED_INPUTS) {
    issues.push({
      at: "inputs",
      message: `declares ${names.length} inputs; at most ${MAX_DECLARED_INPUTS}`,
    })
  }
  for (const name of names) {
    const at = `inputs.${name}`
    const declaration = inputs[name]
    if (
      (name === "map" || name === "controls") &&
      isPlainObject(declaration) &&
      declaration.min === undefined
    ) {
      issues.push({
        at,
        message:
          "is format 1's; since format 2 a game declares each input as { min, max } and binds devices in its own code",
      })
      continue
    }
    if (!INPUT_NAME.test(name)) {
      issues.push({
        at,
        message: "must be a name: a lower-case letter, then letters and digits",
      })
    }
    if (!isPlainObject(declaration)) {
      issues.push({ at, message: "must be { min, max }" })
      continue
    }
    for (const field of Object.keys(declaration)) {
      if (!INPUT_FIELDS.has(field)) {
        issues.push({
          at: `${at}.${field}`,
          message: "is not a field of an input",
        })
      }
    }
    const { min, max, label } = declaration
    for (const [field, bound] of [
      ["min", min],
      ["max", max],
    ] as const) {
      if (
        typeof bound !== "number" ||
        !Number.isInteger(bound) ||
        Math.abs(bound) > INPUT_BOUND
      ) {
        issues.push({
          at: `${at}.${field}`,
          message: `must be a whole number within ${INPUT_BOUND} either side of 0`,
        })
      }
    }
    if (typeof min === "number" && typeof max === "number" && min > max) {
      issues.push({ at: `${at}.max`, message: "must not be below min" })
    }
    if (label !== undefined && typeof label !== "string") {
      issues.push({ at: `${at}.label`, message: "must be a string" })
    }
  }
}

/** A field format 3 removed, refused by name so its author learns why. */
const REMOVED =
  "is not in format 3: no run has a step limit and nothing reads this, so remove it"

/**
 * What changed since each older format, so a manifest written for one says
 * what to change rather than only that its number is wrong.
 */
const FORMAT_CHANGES: Readonly<Record<string, string>> = {
  "1": "must be 3: format 1 bound device codes in inputs.map and declared inputs.controls, and since format 2 a game declares each input by name and range. Format 3 then removed session.maxTicks, session.maxWallSeconds and budgets.bundleBytes, and made rankBy and tiePolicy optional",
  "2": "must be 3: format 3 removed session.maxTicks and session.maxWallSeconds, because no run has a step limit, and budgets.bundleBytes, which nothing read; rankBy and tiePolicy are optional, declared together or not at all",
}

/** Every problem with a manifest, in document order. */
export function validateManifest(value: unknown): Issue[] {
  const issues: Issue[] = []
  if (!isPlainObject(value)) {
    return [{ at: "", message: "must be an object" }]
  }
  const m = value as Record<string, unknown>

  if (m.schemaVersion !== MANIFEST_FORMAT) {
    issues.push({
      at: "schemaVersion",
      message:
        FORMAT_CHANGES[String(m.schemaVersion)] ?? `must be ${MANIFEST_FORMAT}`,
    })
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
    if (typeof session.hasEnding !== "boolean") {
      issues.push({ at: "session.hasEnding", message: "must be true or false" })
    }
    for (const field of ["maxTicks", "maxWallSeconds"]) {
      if (session[field] !== undefined) {
        issues.push({ at: `session.${field}`, message: REMOVED })
      }
    }
  }
  if (isPlainObject(m.budgets) && m.budgets.bundleBytes !== undefined) {
    issues.push({ at: "budgets.bundleBytes", message: REMOVED })
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

  // How a run ranks is optional, and declared whole: rankBy and tiePolicy
  // together, or neither. Either one alone is a ranking half written.
  const rankBy = m.rankBy
  if ((rankBy === undefined) !== (m.tiePolicy === undefined)) {
    issues.push({
      at: rankBy === undefined ? "rankBy" : "tiePolicy",
      message:
        "must be declared with the other: a game declares rankBy and tiePolicy together, or neither",
    })
  }
  if (rankBy !== undefined) {
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
  }
  if (
    m.tiePolicy !== undefined &&
    !TIE_POLICIES.includes(m.tiePolicy as TiePolicy)
  ) {
    issues.push({
      at: "tiePolicy",
      message: 'must be "shared", "earliest" or "none"',
    })
  }

  checkInputDeclarations(m.inputs, issues)

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
        } else if (
          !ASSET_PATH_PATTERN.test(asset.path) ||
          asset.path.split("/").some((part) => part === "." || part === "..")
        ) {
          issues.push({
            at: `${at}.path`,
            message:
              "must be a relative path of letters, digits, '.', '_', '-' and '/', with no '.' or '..' segment",
          })
        } else if (paths.has(asset.path.toLowerCase())) {
          // Case-blind, because macOS and Windows store these as one file.
          issues.push({ at: `${at}.path`, message: "is declared twice" })
        } else {
          paths.add(asset.path.toLowerCase())
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
        if (asset.load !== undefined) {
          if (typeof asset.load !== "string" || !ASSET_LOADS.has(asset.load)) {
            issues.push({
              at: `${at}.load`,
              message: 'must be "start" or "demand"',
            })
          } else if (asset.requiredForSim !== true) {
            issues.push({
              at: `${at}.load`,
              message:
                "only applies to a pack the simulation reads, which needs requiredForSim: true",
            })
          }
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
