#!/usr/bin/env bun
/**
 * The cross-engine determinism sweep.
 *
 * Everything else in this repository assumes the property this script checks:
 * that the same simulation, fed the same seed, config and inputs, reaches the
 * same state on every JavaScript engine a player might be using. It is the
 * check that matters most, because if it does not hold, nothing built on top
 * of it means anything.
 *
 *   bun run scripts/engines.ts                  every engine on this machine
 *   bun run scripts/engines.ts --require-all    a missing engine is a failure
 *   bun run scripts/engines.ts --heavy          include the long session vector
 *   bun run scripts/engines.ts --only=dmath/pow one vector
 *   bun run scripts/engines.ts --update         rewrite the golden file
 *
 * Exit codes: 0 agreement, 1 a divergence, 2 a missing engine under
 * --require-all, 3 the harness itself failed.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { dirname } from "node:path"
import { buildProbeBundle, type ProbeBundle } from "./engines/build"
import {
  detectEngines,
  type EngineAvailability,
  type EngineId,
} from "./engines/detect"
import { type ProbeAnswer, runProbeOn } from "./engines/run"

const GOLDEN = "packages/kernel/tests/probe/probe-golden.tsv"
const ARTIFACTS = "test-results/engines"

interface Options {
  readonly requireAll: boolean
  readonly heavy: boolean
  readonly only: readonly string[] | undefined
  readonly update: boolean
  readonly engines: readonly EngineId[] | undefined
  readonly detail: number | undefined
}

function parseOptions(argv: readonly string[]): Options {
  const flag = (name: string): boolean => argv.includes(`--${name}`)
  const value = (name: string): string | undefined => {
    const found = argv.find((a) => a.startsWith(`--${name}=`))
    return found?.slice(name.length + 3)
  }
  const only = value("only")
  const engines = value("engines")
  const detail = value("detail")
  return {
    requireAll: flag("require-all"),
    heavy: flag("heavy"),
    only: only === undefined ? undefined : only.split(","),
    update: flag("update"),
    engines:
      engines === undefined ? undefined : (engines.split(",") as EngineId[]),
    detail: detail === undefined ? undefined : Number(detail),
  }
}

function readGolden(): Map<string, string> {
  if (!existsSync(GOLDEN)) return new Map()
  const map = new Map<string, string>()
  for (const line of readFileSync(GOLDEN, "utf8").split("\n")) {
    if (line.length === 0 || line.startsWith("#")) continue
    const [id, digest] = line.split("\t")
    if (id !== undefined && digest !== undefined) map.set(id, digest)
  }
  return map
}

function writeGolden(vectors: ProbeAnswer["vectors"]): void {
  mkdirSync(dirname(GOLDEN), { recursive: true })
  const lines = [
    "# Cross-engine probe digests. Written by scripts/engines.ts --update.",
    "# A change here means the simulation changed. Say why in the commit body.",
    ...vectors.map((v) => `${v.id}\t${v.digest}`),
  ]
  writeFileSync(GOLDEN, `${lines.join("\n")}\n`)
}

/**
 * Narrows a divergence to one item by halving, over the wire.
 *
 * Seventeen round trips place the first differing item in a hundred thousand,
 * which beats sending a hundred thousand values and diffing them.
 */
async function bisect(
  bundle: ProbeBundle,
  id: string,
  count: number,
  left: EngineId,
  right: EngineId,
): Promise<number> {
  let low = 0
  let high = count
  while (high - low > 1) {
    const middle = Math.floor((low + high) / 2)
    const request = { kind: "range" as const, id, from: low, to: middle }
    const [a, b] = await Promise.all([
      runProbeOn(left, bundle, request) as Promise<{ digest: string }>,
      runProbeOn(right, bundle, request) as Promise<{ digest: string }>,
    ])
    if (a.digest === b.digest) low = middle
    else high = middle
  }
  return low
}

async function main(): Promise<number> {
  const options = parseOptions(process.argv.slice(2))
  const bundle = await buildProbeBundle()

  const detected = await detectEngines()
  const wanted =
    options.engines === undefined
      ? detected
      : detected.filter((e) =>
          (options.engines as readonly EngineId[]).includes(e.id),
        )

  const present = wanted.filter((e) => e.available)
  const missing = wanted.filter((e) => !e.available)

  console.log(`probe bundle sha256 ${bundle.digest}`)
  console.log("")

  for (const engine of missing) {
    console.log(
      `SKIPPED  ${engine.id} (${engine.jsEngine})  not installed\n         fix: ${engine.hint ?? ""}`,
    )
  }
  if (missing.length > 0) console.log("")

  if (present.length === 0) {
    console.error("no engines available at all")
    return 3
  }

  const request = {
    kind: "run" as const,
    ...(options.only === undefined ? {} : { only: options.only }),
    ...(options.heavy ? { heavy: true } : {}),
  }

  const answers = new Map<EngineId, ProbeAnswer>()
  for (const engine of present) {
    const started = Date.now()
    const answer = (await runProbeOn(engine.id, bundle, request)) as ProbeAnswer
    answers.set(engine.id, answer)
    console.log(
      `ran ${engine.id} (${engine.jsEngine}) in ${((Date.now() - started) / 1000).toFixed(2)}s`,
    )
  }
  console.log("")

  const reference = present[0] as EngineAvailability
  const referenceAnswer = answers.get(reference.id) as ProbeAnswer
  const golden = options.update ? new Map<string, string>() : readGolden()

  const nameWidth = Math.max(
    ...referenceAnswer.vectors.map((v) => v.id.length),
    "vector".length,
  )
  const header = [
    "vector".padEnd(nameWidth),
    ...present.map((e) => e.id.padEnd(10)),
  ]
  console.log(header.join("  "))

  let divergences = 0
  let goldenMismatches = 0

  for (const vector of referenceAnswer.vectors) {
    const cells: string[] = []
    let rowDiffers = false
    for (const engine of present) {
      const other = (answers.get(engine.id) as ProbeAnswer).vectors.find(
        (v) => v.id === vector.id,
      )
      if (engine.id === reference.id) {
        cells.push(vector.digest.slice(0, 10).padEnd(10))
        continue
      }
      if (other === undefined) {
        cells.push("MISSING   ")
        rowDiffers = true
        continue
      }
      if (other.digest === vector.digest) {
        cells.push("=".padEnd(10))
      } else {
        cells.push(`x ${other.digest.slice(0, 8)}`)
        rowDiffers = true
      }
    }
    const expected = golden.get(vector.id)
    const goldenMark =
      options.update || expected === undefined
        ? ""
        : expected === vector.digest
          ? ""
          : "   GOLDEN CHANGED"
    if (goldenMark !== "") goldenMismatches++
    console.log([vector.id.padEnd(nameWidth), ...cells].join("  ") + goldenMark)
    if (rowDiffers) divergences++
  }
  console.log("")

  if (divergences > 0) {
    mkdirSync(ARTIFACTS, { recursive: true })
    for (const vector of referenceAnswer.vectors) {
      for (const engine of present) {
        if (engine.id === reference.id) continue
        const other = (answers.get(engine.id) as ProbeAnswer).vectors.find(
          (v) => v.id === vector.id,
        )
        if (other === undefined || other.digest === vector.digest) continue

        console.log(
          `DIVERGENCE  ${vector.id}   ${reference.id} (${reference.jsEngine}) against ${engine.id} (${engine.jsEngine})`,
        )
        const index = await bisect(
          bundle,
          vector.id,
          vector.count,
          reference.id,
          engine.id,
        )
        const from = Math.max(0, index - 2)
        const to = index + 3
        const detailRequest = {
          kind: "detail" as const,
          id: vector.id,
          from,
          to,
        }
        type DetailRow = { index: number; in: string; out: string }
        const both = (await Promise.all([
          runProbeOn(reference.id, bundle, detailRequest),
          runProbeOn(engine.id, bundle, detailRequest),
        ])) as DetailRow[][]
        const left = both[0] ?? []
        const right = both[1] ?? []
        console.log(`  first differing item: ${index} of ${vector.count}`)
        console.log(
          `  ${"index".padEnd(8)}${"input".padEnd(40)}${reference.id.padEnd(20)}${engine.id}`,
        )
        for (let i = 0; i < left.length; i++) {
          const a = left[i] as { index: number; in: string; out: string }
          const b = right[i]
          const same = b !== undefined && b.out === a.out
          console.log(
            `  ${String(a.index).padEnd(8)}${a.in.slice(0, 38).padEnd(40)}${a.out.padEnd(20)}${same ? "=" : (b?.out ?? "(missing)")}`,
          )
        }
        console.log(
          `  reproduce: bun run scripts/engines.ts --only=${vector.id} --engines=${reference.id},${engine.id} --detail=${index}`,
        )
        console.log("")
        writeFileSync(
          `${ARTIFACTS}/${vector.id.replace(/\//g, "-")}.json`,
          JSON.stringify({ vector: vector.id, index, left, right }, null, 2),
        )
      }
    }
  }

  if (options.update) {
    writeGolden(referenceAnswer.vectors)
    console.log(`wrote ${GOLDEN}`)
  }

  if (divergences > 0) {
    console.error(`${divergences} vector(s) disagree between engines`)
    return 1
  }
  if (goldenMismatches > 0) {
    console.error(
      `${goldenMismatches} vector(s) no longer match ${GOLDEN}. If the simulation changed on purpose, rerun with --update and say why in the commit body.`,
    )
    return 1
  }
  if (options.requireAll && missing.length > 0) {
    console.error(
      `--require-all was given and ${missing.map((e) => e.id).join(", ")} ${missing.length === 1 ? "is" : "are"} missing`,
    )
    return 2
  }

  console.log(
    `every vector agrees across ${present.map((e) => e.id).join(", ")}${missing.length > 0 ? `; ${missing.length} engine(s) skipped` : ""}`,
  )
  return 0
}

main()
  .then((code) => process.exit(code))
  .catch((error: unknown) => {
    console.error(error)
    process.exit(3)
  })
