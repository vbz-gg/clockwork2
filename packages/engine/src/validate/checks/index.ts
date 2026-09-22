/**
 * The twelve conformance checks.
 *
 * Each one is written against a failure that actually happened, not against a
 * principle. Check 1 exists because a game shipped with `Math.random()` in a
 * timer and a run nobody played was paid and ranked. Check 3 exists because
 * the platform used its validator's ten-second timeout as the real bound on a
 * session. Check 6 exists because without it there is no way to know whether a
 * snapshot is complete. Check 10 exists because a claimed score was never
 * compared against the replayed one.
 */

import { createHash } from "node:crypto"
import { readdirSync, readFileSync, statSync } from "node:fs"
import { join } from "node:path"
import {
  compareToRecording,
  decodeRecording,
  encodeRecording,
  hashCanonical,
  RECORDING_FORMAT,
  RECORDING_VERSION,
  RecordedInputSource,
  type Recording,
  runSession,
  Session,
  type SessionResult,
  type Snapshot,
  validateManifest,
} from "../.."
import { compareCounters } from "../../testing"
import { scanImportGraph } from "../scan/import-graph"
import type { Check, Finding } from "../types"
import {
  CHECKPOINT_EVERY,
  codeFromError,
  countersOf,
  firstDivergence,
  logsFor,
  runOnce,
  tryRun,
} from "./support"

const determinism: Check = {
  name: "determinism",
  title: "The same seed, config and inputs reach the same state",
  async run({ subject, seeds }) {
    const findings: Finding[] = []
    let runs = 0
    for (const seed of seeds) {
      for (const [logName, inputs] of logsFor(subject.manifest, seed)) {
        // Twice in one process, then once from a freshly evaluated module. A
        // fresh instance is not enough: a module-level counter survives one.
        const attempts = [
          await tryRun(subject, { seed, inputs }),
          await tryRun(subject, { seed, inputs }),
          await tryRun(subject, { seed, inputs }),
        ]
        runs += 3
        const failed = attempts.find((a) => "error" in a)
        if (failed !== undefined && "error" in failed) {
          findings.push({
            code: codeFromError(failed.error, "E_DETERMINISM_DIVERGED"),
            check: "determinism",
            detail: `seed ${seed}, ${logName} log: the run threw: ${String(failed.error)}`,
          })
          continue
        }
        const results = attempts.flatMap((a) =>
          "result" in a ? [a.result] : [],
        )
        const first = results[0] as SessionResult
        const second = results[1] as SessionResult
        const fresh = results[2] as SessionResult
        for (const [label, other] of [
          ["a second run in the same process", second],
          ["a run from a freshly evaluated module", fresh],
        ] as const) {
          const where = firstDivergence(first.checkpoints, other.checkpoints)
          if (where !== null) {
            findings.push({
              code: "E_DETERMINISM_DIVERGED",
              check: "determinism",
              detail: `seed ${seed}, ${logName} log, ${label}: ${where}`,
            })
          }
          const counters = compareCounters(first.counters, other.counters)
          if (counters.length > 0) {
            findings.push({
              code: "E_DETERMINISM_DIVERGED",
              check: "determinism",
              detail: `seed ${seed}, ${logName} log, ${label}: ${counters.join("; ")}`,
            })
          }
          if (first.endTick !== other.endTick) {
            findings.push({
              code: "E_DETERMINISM_DIVERGED",
              check: "determinism",
              detail: `seed ${seed}, ${logName} log, ${label}: ended at ${other.endTick}, the first run ended at ${first.endTick}`,
            })
          }
        }
      }
    }
    return {
      ok: findings.length === 0,
      findings,
      note: `${runs} runs compared`,
    }
  },
}

const headless: Check = {
  name: "headless",
  title: "It runs with no browser present",
  async run({ subject }) {
    const findings: Finding[] = []
    // Only `window` and `document` are probed. They are the two that really
    // mean "a browser is here", so a suite accidentally run inside a page
    // fails rather than passing for the wrong reason. `navigator` is not one
    // of them: Bun and Node both define it, and its presence says nothing
    // about the game.
    for (const name of ["window", "document"]) {
      if ((globalThis as Record<string, unknown>)[name] !== undefined) {
        findings.push({
          code: "E_HEADLESS_THREW",
          check: "headless",
          detail: `this run has a ${name}, so it is not a headless environment and the check would prove nothing`,
        })
      }
    }
    try {
      const module = await subject.load({ fresh: true })
      const session = new Session({
        module,
        seed: "headless",
        config: subject.config ?? {},
        inputs: new RecordedInputSource([]),
        maxTicks: Math.max(600, 1),
        checkpointEvery: 0,
        counters: countersOf(subject.manifest),
      })
      for (let i = 0; i < 600 && session.step(); i++) {
        // 600 ticks is ten seconds at 60 Hz: long enough for setup to finish
        // and for a first wave of whatever the game spawns.
      }
    } catch (error) {
      findings.push({
        code: codeFromError(error, "E_HEADLESS_THREW"),
        check: "headless",
        detail: String(error),
      })
    }
    return { ok: findings.length === 0, findings, note: "init and 600 ticks" }
  },
}

const bound: Check = {
  name: "bound",
  title: "The run ends inside maxTicks",
  async run({ subject, seeds }) {
    const findings: Finding[] = []
    const { maxTicks, hasEnding } = subject.manifest.session
    const notes: string[] = []
    for (const seed of seeds) {
      for (const [logName, inputs] of logsFor(subject.manifest, seed)) {
        const attempt = await tryRun(subject, { seed, inputs })
        if ("error" in attempt) {
          findings.push({
            code: codeFromError(attempt.error, "E_BOUND_NOT_OVER"),
            check: "bound",
            detail: `seed ${seed}, ${logName} log: the run threw: ${String(attempt.error)}`,
          })
          continue
        }
        const result = attempt.result
        notes.push(`${logName}:${result.endTick}`)
        if (result.terminal === "timeout") {
          findings.push({
            code: "E_BOUND_NOT_OVER",
            check: "bound",
            tick: result.endTick,
            detail: `seed ${seed}, ${logName} log: isOver() never became true inside ${maxTicks} ticks${
              hasEnding
                ? ""
                : ". The manifest says hasEnding is false, which still requires the difficulty to rise until the run ends"
            }`,
          })
        }
      }
    }
    return {
      ok: findings.length === 0,
      findings,
      note: `end ticks ${notes.join(", ")}`,
    }
  },
}

const bannedApis: Check = {
  name: "banned-apis",
  title: "Nothing in the import graph names a banned API",
  async run({ subject }) {
    if (subject.entry === undefined) {
      return {
        ok: true,
        findings: [],
        skipped: "no entry file was given, so only the runtime traps apply",
      }
    }
    const scan = scanImportGraph(subject.entry)
    const findings: Finding[] = scan.findings
      .filter((f) => f.kind !== "async")
      .map((f) => ({
        code: "E_LINT_BANNED" as const,
        check: "banned-apis",
        detail: `${f.name}: ${f.why}`,
        at: `${f.file}:${f.line}:${f.column}`,
      }))
    for (const specifier of scan.unresolved) {
      findings.push({
        code: "E_LINT_BANNED",
        check: "banned-apis",
        detail: `could not resolve ${specifier}, so the scan could not see what it does`,
      })
    }
    return {
      ok: findings.length === 0,
      findings,
      note: `${scan.files.length} files scanned, ${scan.trusted.length} platform packages trusted`,
    }
  },
}

const noAsync: Check = {
  name: "no-async",
  title: "No asynchronous work in the simulation",
  async run({ subject }) {
    const findings: Finding[] = []
    if (subject.entry !== undefined) {
      for (const f of scanImportGraph(subject.entry).findings) {
        if (f.kind !== "async") continue
        findings.push({
          code: "E_ASYNC_DETECTED",
          check: "no-async",
          detail: `${f.name}: ${f.why}`,
          at: `${f.file}:${f.line}:${f.column}`,
        })
      }
    }

    // A scan misses a promise built without the keywords, so the state is
    // hashed, the microtask queue is drained, and the state is hashed again.
    // The probe is guarded: a game whose tick returns a thenable throws here,
    // and that is a finding rather than a reason to lose the scan's findings.
    try {
      const module = await subject.load({ fresh: true })
      const session = new Session({
        module,
        seed: "async-probe",
        config: subject.config ?? {},
        inputs: new RecordedInputSource([]),
        maxTicks: 120,
        checkpointEvery: 0,
        counters: countersOf(subject.manifest),
      })
      for (let i = 0; i < 60 && session.step(); i++) {
        // advance into the middle of the game
      }
      const before = hashCanonical(module.snapshot())
      await Promise.resolve()
      await new Promise((resolve) => queueMicrotask(() => resolve(null)))
      const after = hashCanonical(module.snapshot())
      if (before !== after) {
        findings.push({
          code: "E_ASYNC_DETECTED",
          check: "no-async",
          detail: `state changed while the microtask queue drained: ${before} became ${after}`,
        })
      }
    } catch (error) {
      findings.push({
        code: codeFromError(error, "E_ASYNC_DETECTED"),
        check: "no-async",
        detail: String(error),
      })
    }
    return { ok: findings.length === 0, findings }
  },
}

const restore: Check = {
  name: "restore",
  title: "Restore then continue equals continue",
  async run({ subject, seeds }) {
    const findings: Finding[] = []
    const seed = seeds[0] as string
    const log = logsFor(subject.manifest, seed).get("bot") ?? []
    const baseline = await tryRun(subject, { seed, inputs: log })
    if ("error" in baseline) {
      return {
        ok: false,
        findings: [
          {
            code: codeFromError(baseline.error, "E_RESTORE_MISMATCH"),
            check: "restore",
            detail: `the run this check compares against threw: ${String(baseline.error)}`,
          },
        ],
      }
    }
    const uninterrupted = baseline.result

    const offsets = [1, 37, 120, Math.floor(uninterrupted.endTick / 2)].filter(
      (at) => at > 0 && at < uninterrupted.endTick,
    )
    for (const at of offsets) {
      const partial = new Session({
        module: await subject.load({ fresh: true }),
        seed,
        config: subject.config ?? {},
        inputs: new RecordedInputSource(log),
        maxTicks: subject.manifest.session.maxTicks,
        checkpointEvery: CHECKPOINT_EVERY,
        counters: countersOf(subject.manifest),
      })
      for (let i = 0; i < at; i++) partial.step()
      // Through JSON, because that is the trip a snapshot actually takes.
      const snapshot = JSON.parse(
        JSON.stringify(partial.result().snapshot),
      ) as Snapshot

      const resumed = runSession({
        module: await subject.load({ fresh: true }),
        seed,
        config: subject.config ?? {},
        inputs: new RecordedInputSource(log),
        maxTicks: subject.manifest.session.maxTicks,
        checkpointEvery: CHECKPOINT_EVERY,
        counters: countersOf(subject.manifest),
        resumeFrom: { snapshot, tick: at },
      })

      if (resumed.endTick !== uninterrupted.endTick) {
        findings.push({
          code: "E_RESTORE_MISMATCH",
          check: "restore",
          tick: at,
          detail: `resuming at ${at} ended at ${resumed.endTick}, uninterrupted ended at ${uninterrupted.endTick}`,
        })
        continue
      }
      const later = uninterrupted.checkpoints.filter((c) => c.tick >= at)
      const where = firstDivergence(later, resumed.checkpoints)
      if (where !== null) {
        findings.push({
          code: "E_RESTORE_MISMATCH",
          check: "restore",
          tick: at,
          detail: `resuming at ${at} diverged: ${where}`,
        })
      }
      const counters = compareCounters(uninterrupted.counters, resumed.counters)
      if (counters.length > 0) {
        findings.push({
          code: "E_RESTORE_MISMATCH",
          check: "restore",
          tick: at,
          detail: `resuming at ${at}: ${counters.join("; ")}`,
        })
      }
    }
    return {
      ok: findings.length === 0,
      findings,
      note: `resumed at ${offsets.join(", ")}`,
    }
  },
}

function walkFiles(root: string, prefix = ""): string[] {
  const out: string[] = []
  for (const entry of readdirSync(join(root, prefix))) {
    const relativePath = prefix === "" ? entry : `${prefix}/${entry}`
    const full = join(root, relativePath)
    if (statSync(full).isDirectory()) out.push(...walkFiles(root, relativePath))
    else out.push(relativePath)
  }
  return out
}

const budgets: Check = {
  name: "budgets",
  title: "Every file is declared, hashed and inside its budget",
  async run({ subject }) {
    if (subject.root === undefined) {
      return {
        ok: true,
        findings: [],
        skipped: "no bundle directory was given",
      }
    }
    const findings: Finding[] = []
    const declared = new Map(
      (subject.manifest.assets ?? []).map((asset) => [asset.path, asset]),
    )
    const present = new Set(walkFiles(subject.root))
    let totalBytes = 0

    for (const [path, asset] of declared) {
      if (!present.has(path)) {
        findings.push({
          code: "E_BUDGET_EXCEEDED",
          check: "budgets",
          detail: `${path} is declared but not present`,
        })
        continue
      }
      const bytes = readFileSync(join(subject.root, path))
      totalBytes += bytes.byteLength
      const digest = createHash("sha256").update(bytes).digest("hex")
      if (digest !== asset.sha256) {
        findings.push({
          code: "E_BUDGET_EXCEEDED",
          check: "budgets",
          detail: `${path} hashes to ${digest}, the manifest says ${asset.sha256}`,
        })
      }
      if (bytes.byteLength !== asset.bytes) {
        findings.push({
          code: "E_BUDGET_EXCEEDED",
          check: "budgets",
          detail: `${path} is ${bytes.byteLength} bytes, the manifest says ${asset.bytes}`,
        })
      }
    }

    const budget = subject.manifest.budgets?.assetBytes
    if (budget !== undefined && totalBytes > budget) {
      findings.push({
        code: "E_BUDGET_EXCEEDED",
        check: "budgets",
        detail: `assets total ${totalBytes} bytes, budget is ${budget}`,
      })
    }

    return {
      ok: findings.length === 0,
      findings,
      note: `${declared.size} declared assets, ${totalBytes} bytes`,
    }
  },
}

const performance_: Check = {
  name: "performance",
  title: "A tick costs less than its budget",
  async run({ subject, seeds }) {
    const seed = seeds[0] as string
    const log = logsFor(subject.manifest, seed).get("bot") ?? []
    const module = await subject.load({ fresh: true })
    const started = Date.now()
    let result: SessionResult
    try {
      result = runSession({
        module,
        seed,
        config: subject.config ?? {},
        inputs: new RecordedInputSource(log),
        maxTicks: subject.manifest.session.maxTicks,
        checkpointEvery: CHECKPOINT_EVERY,
        counters: countersOf(subject.manifest),
      })
    } catch (error) {
      return {
        ok: false,
        findings: [
          {
            code: codeFromError(error, "E_PERF_BUDGET"),
            check: "performance",
            detail: String(error),
          },
        ],
      }
    }
    const elapsed = Date.now() - started
    const perTickMicroseconds = (elapsed * 1000) / Math.max(result.endTick, 1)
    const budget = subject.manifest.budgets?.microsecondsPerTick
    const findings: Finding[] =
      budget !== undefined && perTickMicroseconds > budget
        ? [
            {
              code: "E_PERF_BUDGET",
              check: "performance",
              detail: `${perTickMicroseconds.toFixed(1)} microseconds per tick, budget is ${budget}`,
            },
          ]
        : []
    return {
      ok: findings.length === 0,
      findings,
      note: `${result.endTick} ticks in ${elapsed} ms, ${perTickMicroseconds.toFixed(1)} microseconds each`,
    }
  },
}

const counters: Check = {
  name: "counters",
  title: "Counters behave as the manifest declares",
  async run({ subject, seeds }) {
    // The kernel's CounterTracker enforces this every tick, so reaching the
    // end of a run is the check. What is added here is the error code and the
    // seed that produced it.
    const findings: Finding[] = []
    for (const seed of seeds) {
      for (const [logName, inputs] of logsFor(subject.manifest, seed)) {
        const attempt = await tryRun(subject, { seed, inputs })
        if ("error" in attempt) {
          findings.push({
            code: codeFromError(attempt.error, "E_COUNTER_RANGE"),
            check: "counters",
            detail: `seed ${seed}, ${logName} log: ${String(attempt.error)}`,
          })
        }
      }
    }
    return { ok: findings.length === 0, findings }
  },
}

const replayRoundTrip: Check = {
  name: "replay",
  title: "A recording serialises, deserialises and replays to the same state",
  async run({ subject, seeds }) {
    const findings: Finding[] = []
    for (const seed of seeds) {
      const log = logsFor(subject.manifest, seed).get("bot") ?? []
      const recorded = await runOnce(subject, { seed, inputs: log })
      const recording: Recording = {
        format: RECORDING_FORMAT,
        version: RECORDING_VERSION,
        kernelVersion: subject.manifest.kernel.version,
        gameId: subject.manifest.id,
        gameVersion: subject.manifest.version,
        manifestHash: hashCanonical(subject.manifest as never),
        tickHz: subject.manifest.session.tickHz,
        seed,
        config: (subject.config ?? {}) as never,
        inputs: log.filter((event) => event.tick <= recorded.endTick),
        checkpoints: recorded.checkpoints,
        endTick: recorded.endTick,
        terminal: recorded.terminal,
        counters: recorded.counters,
      }

      let decoded: ReturnType<typeof decodeRecording>
      try {
        decoded = decodeRecording(encodeRecording(recording))
      } catch (error) {
        findings.push({
          code: "E_REPLAY_MISMATCH",
          check: "replay",
          detail: `seed ${seed}: the recording did not survive a round trip: ${String(error)}`,
        })
        continue
      }

      const replayed = await runOnce(subject, { seed, inputs: decoded.inputs })
      const comparison = compareToRecording(decoded, replayed)
      if (!comparison.matches) {
        findings.push({
          code: "E_REPLAY_MISMATCH",
          check: "replay",
          ...(comparison.divergedAt === null
            ? {}
            : { tick: comparison.divergedAt }),
          detail: `seed ${seed}: ${comparison.differences.slice(0, 5).join("; ")}`,
        })
      }
    }
    return {
      ok: findings.length === 0,
      findings,
      note: `${seeds.length} recordings`,
    }
  },
}

const manifestAndGlobals: Check = {
  name: "manifest",
  title: "The manifest is valid and the bundle touches no embedder global",
  async run({ subject }) {
    const findings: Finding[] = validateManifest(subject.manifest).map(
      (issue) => ({
        code: "E_MANIFEST_SCHEMA" as const,
        check: "manifest",
        detail: `${issue.at || "<root>"}: ${issue.message}`,
      }),
    )

    if (subject.entry !== undefined) {
      const scan = scanImportGraph(subject.entry)
      for (const finding of scan.findings) {
        if (
          finding.name === "window.top" ||
          finding.name === "window.parent" ||
          finding.name === "document.cookie" ||
          finding.name === "XMLHttpRequest"
        ) {
          findings.push({
            code: "E_GLOBALS_TOUCHED",
            check: "manifest",
            detail: `${finding.name}: ${finding.why}`,
            at: `${finding.file}:${finding.line}:${finding.column}`,
          })
        }
      }
    }

    const kernelMajor = subject.manifest.kernel.version.split(".")[0]
    if (kernelMajor === undefined) {
      findings.push({
        code: "E_MANIFEST_SCHEMA",
        check: "manifest",
        detail: "kernel.version has no major",
      })
    }
    return { ok: findings.length === 0, findings }
  },
}

const renderSmoke: Check = {
  name: "render-smoke",
  title: "The render bundle draws a canned state without leaving the frame",
  async run() {
    return {
      ok: true,
      findings: [],
      skipped:
        "no render bundle was given. The browser half of this check lives in the e2e suite, which drives a real page.",
    }
  },
}

export const CHECKS: readonly Check[] = [
  determinism,
  headless,
  bound,
  bannedApis,
  noAsync,
  restore,
  budgets,
  performance_,
  counters,
  replayRoundTrip,
  manifestAndGlobals,
  renderSmoke,
]
