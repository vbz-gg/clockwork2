#!/usr/bin/env bun
/**
 * Runs a game with no browser, prints its checkpoints, and says where it
 * ended.
 *
 * Use it to answer three questions the suite answers less directly: does my
 * game end on its own, what does a session actually look like, and did the
 * change I just made move any state that was already recorded.
 *
 *   run-headless.ts ./src
 *   run-headless.ts ./src --seed=abc --log=bot --ticks=3600
 *   run-headless.ts ./src --log=idle --quiet   only the last line
 *
 * `--log` is one of idle, chaos or bot. They are generated from the seed by
 * `@clockwork2/kernel/testing`, not read from a file, so a log is reproducible
 * from two words rather than from an artefact somebody has to keep.
 */

import type * as Kernel from "@clockwork2/kernel"
import type * as KernelTesting from "@clockwork2/kernel/testing"
import type * as Validate from "@clockwork2/validate"
import { resolveFrom } from "./_resolve"

function flag(name: string, fallback: string): string {
  const found = process.argv.find((a) => a.startsWith(`--${name}=`))
  return found === undefined ? fallback : found.slice(name.length + 3)
}

const target = process.argv[2]
if (target === undefined || target.startsWith("--")) {
  console.error("usage: run-headless.ts <path> [--seed=] [--log=] [--ticks=]")
  process.exit(2)
}

const seed = flag("seed", "headless-1")
const logName = flag("log", "bot")
const quiet = process.argv.includes("--quiet")

const kernel = await resolveFrom<typeof Kernel>("@clockwork2/kernel", target)
const testing = await resolveFrom<typeof KernelTesting>(
  "@clockwork2/kernel/testing",
  target,
)
const validate = await resolveFrom<typeof Validate>(
  "@clockwork2/validate",
  target,
)

const subject = await validate.loadSubject(target)
const maxTicks = Number(
  flag("ticks", String(subject.manifest.session.maxTicks)),
)
const logs = testing.standardLogs(seed, maxTicks)
const inputs = logs.get(logName)
if (inputs === undefined) {
  console.error(`unknown log ${logName}; one of ${[...logs.keys()].join(", ")}`)
  process.exit(2)
}

const started = performance.now()
const result = kernel.runSession({
  module: await subject.load({ fresh: true }),
  seed,
  config: (subject.config ?? {}) as Kernel.PlainValue,
  inputs: new kernel.RecordedInputSource(inputs),
  maxTicks,
  checkpointEvery: subject.manifest.session.tickHz,
  counters: subject.manifest.counters,
})
const ms = performance.now() - started

if (!quiet) {
  for (const checkpoint of result.checkpoints) {
    console.log(`${String(checkpoint.tick).padStart(7)}  ${checkpoint.hash}`)
  }
}
const counters = Object.entries(result.counters)
  .map(([name, value]) => `${name}=${String(value)}`)
  .join(" ")
console.log(
  `${result.terminal} at tick ${result.endTick} after ${inputs.length} inputs  ${counters}  (${ms.toFixed(0)} ms)`,
)
if (result.terminal === "timeout") {
  console.error(
    "\nthe run hit maxTicks without ending: check 3 (bound) will fail this",
  )
  process.exit(1)
}
