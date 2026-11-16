/**
 * The tilt check: a page that walks the person holding a phone through a few
 * poses, takes the readings itself, and ends with a summary and a button that
 * copies every reading, so the results can be pasted back to whoever asked.
 *
 * The counting game from the inputs page runs here with one mapping, tilt onto
 * its three signed axes, so what each step judges is exactly what the device
 * helper records. `check.ts` decides when a step is done and whether it
 * passed; this file only wires it to the page.
 *
 * Tilt is unverified on real phones until somebody holds one, which is what
 * this page is for. A browser spec walks it under Chromium's orientation
 * override.
 */

import { assertManifest, type InputEvent } from "@clockwork2/engine"
import {
  currentScreenAngle,
  type DeviceNotice,
  GameHost,
  InputCapture,
  type MotionAccess,
  requestMotion,
} from "@clockwork2/engine/host"
import { createGame, type InputsView, MANIFEST } from "../inputs/game"
import {
  heldStill,
  judge,
  readingRate,
  type Sample,
  SCROLL_MS,
  STEPS,
  type StepResult,
  turnedTooSoon,
} from "./check"

/** Bumped when what the results carry changes. */
const CHECK_VERSION = 2
/** How often the recorded tilt is looked at. */
const SAMPLE_MS = 100

const element = <T extends HTMLElement>(id: string): T => {
  const node = document.querySelector<T>(`#${id}`)
  if (node === null) throw new Error(`the page has no #${id}`)
  return node
}
const field = element("field")
const dot = element("dot")
const buttons = {
  allow: element<HTMLButtonElement>("allow"),
  retry: element<HTMLButtonElement>("retry"),
  proceed: element<HTMLButtonElement>("continue"),
  skip: element<HTMLButtonElement>("skip"),
  copy: element<HTMLButtonElement>("copy"),
}

function say(id: string, text: string): void {
  element(id).textContent = text
}

/** The last recorded value of each tilt axis, or 0 before one arrives. */
function latest(log: readonly InputEvent[]): {
  x: number
  y: number
  z: number
} {
  const last = { x: 0, y: 0, z: 0 }
  for (const input of log) {
    if (input.code === "tiltX") last.x = input.value
    else if (input.code === "tiltY") last.y = input.value
    else if (input.code === "tiltZ") last.z = input.value
  }
  return last
}

/** The angle the device helpers use, so the steps judge the same frame. */
function screenAngle(): number | null {
  return currentScreenAngle() ?? null
}

/** What each of the browser's two sources says. */
function reportedAngles(): { screen: number | null; window: number | null } {
  const legacy = (window as unknown as { orientation?: unknown }).orientation
  return {
    screen: screen.orientation?.angle ?? null,
    window: typeof legacy === "number" ? legacy : null,
  }
}

/** The screen's orientation lock, which only some browsers have. */
type Lockable = { lock?: (type: string) => Promise<void>; unlock?: () => void }

function said(reason: unknown): string {
  return reason instanceof Error
    ? `${reason.name}: ${reason.message}`
    : String(reason)
}

/** Locks the screen to `type`, and says how that went. */
async function lockTo(type: string): Promise<string> {
  const orientation = screen.orientation as
    | (ScreenOrientation & Lockable)
    | undefined
  if (typeof orientation?.lock !== "function") return "unsupported"
  try {
    await orientation.lock(type)
    return "locked"
  } catch (reason) {
    return said(reason)
  }
}

/**
 * Asks for full screen, which a browser needs before it will lock the
 * screen's orientation. Called inside the tap, after the tilt request.
 */
function enterFullscreen(): Promise<string> {
  const root = document.documentElement
  if (typeof root.requestFullscreen !== "function") {
    return Promise.resolve("unsupported")
  }
  return root.requestFullscreen().then(
    () => "entered",
    (reason: unknown) => said(reason),
  )
}

function leaveFullscreen(): void {
  ;(
    screen.orientation as (ScreenOrientation & Lockable) | undefined
  )?.unlock?.()
  if (document.fullscreenElement !== null) void document.exitFullscreen()
}

function device() {
  const legacy = (window as unknown as { orientation?: number }).orientation
  const orientation = (
    globalThis as unknown as {
      DeviceOrientationEvent?: { requestPermission?: unknown }
    }
  ).DeviceOrientationEvent
  return {
    userAgent: navigator.userAgent,
    platform: navigator.platform,
    screen: {
      width: screen.width,
      height: screen.height,
      pixelRatio: devicePixelRatio,
    },
    orientationType: screen.orientation?.type ?? null,
    angleAtStart: screenAngle(),
    anglesAtStart: reportedAngles(),
    windowOrientation: legacy ?? null,
    secureContext: isSecureContext,
    topLevel: window.top === window,
    orientationEvents: orientation !== undefined,
    asksPermission: typeof orientation?.requestPermission === "function",
  }
}

function start(): void {
  assertManifest(MANIFEST)
  const notices: DeviceNotice[] = []
  const host = new GameHost<InputsView>({
    module: createGame(),
    manifest: MANIFEST,
    seed: "tilt",
    onError: (error) => {
      say("status", error instanceof Error ? error.message : String(error))
    },
  })
  const queue = host.live
  if (queue === null) throw new Error("a live session has a live queue")
  new InputCapture({
    manifest: MANIFEST,
    queue,
    element: field,
    tilt: { x: "tiltX", y: "tiltY", z: "tiltZ" },
    onNotice: (notice) => {
      notices.push(notice)
    },
  }).attach()

  // The browser's own reading, and when each arrived.
  let raw: {
    beta: number | null
    gamma: number | null
    alpha: number | null
    absolute: boolean
  } = { beta: null, gamma: null, alpha: null, absolute: false }
  const readingTimes: number[] = []
  window.addEventListener("deviceorientation", (event) => {
    raw = {
      beta: event.beta,
      gamma: event.gamma,
      alpha: event.alpha,
      absolute: event.absolute,
    }
    readingTimes.push(performance.now())
    if (readingTimes.length > 5000) readingTimes.splice(0, 1000)
  })

  const results = {
    check: CHECK_VERSION,
    at: new Date().toISOString(),
    device: device(),
    permission: [] as MotionAccess[],
    steps: [] as StepResult[],
    scroll: null as null | "skipped" | Record<string, unknown>,
    // How the screen was kept upright: by the page, or by the person's own
    // rotation lock when the page could not.
    orientation: {
      fullscreen: "not asked",
      portrait: "not asked",
      landscape: "not asked",
      byHand: false,
    },
    readings: 0,
    notices,
  }

  let phase: "allow" | "rotation" | "step" | "scroll" | "done" = "allow"
  let pageLocked = false
  let stepIndex = 0
  let samples: Sample[] = []
  let portraitAngle: number | null = screenAngle()
  let scrolledFrom: number | null = null
  let scrolledTo = 0

  const showStep = (): void => {
    const step = STEPS[stepIndex]
    if (step === undefined) {
      beginScroll()
      return
    }
    samples = []
    say("progress", `Step ${stepIndex + 1} of ${STEPS.length + 1}`)
    say(
      "instruction",
      pageLocked && step.instructionWhenLocked !== undefined
        ? step.instructionWhenLocked
        : step.instruction,
    )
    say("status", "Waiting for the phone to hold still in that position.")
    buttons.skip.hidden = !step.skippable
    if (
      pageLocked &&
      step.sideways &&
      results.orientation.landscape === "not asked"
    ) {
      void lockTo("landscape-primary").then((answer) => {
        results.orientation.landscape = answer
      })
    }
  }

  // The steps begin with the screen upright, whichever way kept it there.
  const beginSteps = (): void => {
    phase = "step"
    portraitAngle = screenAngle()
    buttons.proceed.hidden = true
    showStep()
  }

  const askForRotationLock = (): void => {
    phase = "rotation"
    results.orientation.byHand = true
    say("progress", "Before you start")
    say(
      "instruction",
      "Turn on your phone's rotation lock, so the screen stays upright while you tilt it. On an iPhone or iPad, swipe down from the top-right corner and tap the padlock. On Android, turn Auto-rotate off in the quick settings. Then tap Continue.",
    )
    say("status", "")
    buttons.proceed.hidden = false
  }

  const next = (result: StepResult): void => {
    results.steps.push(result)
    stepIndex++
    showStep()
  }

  const beginScroll = (): void => {
    phase = "scroll"
    if (pageLocked) void lockTo("portrait-primary")
    say("progress", `Step ${STEPS.length + 1} of ${STEPS.length + 1}`)
    say(
      "instruction",
      "Scroll this page up and down with your thumb for a few seconds, tilting the phone as you do.",
    )
    say("status", "Waiting for you to scroll.")
    element("scroll").hidden = false
    buttons.skip.hidden = false
  }

  const finish = (): void => {
    phase = "done"
    leaveFullscreen()
    element("scroll").hidden = true
    buttons.skip.hidden = true
    results.readings = readingTimes.length
    say("progress", "Done")
    say(
      "instruction",
      "Tap Copy results and paste them into the chat with Claude. To check another device, open this page on it.",
    )
    say("status", "")
    const summary = element("summary")
    summary.replaceChildren()
    for (const step of results.steps) {
      const item = document.createElement("li")
      item.className = step.outcome
      const pose = step.pose
      item.textContent = `${step.id}: ${step.outcome}${
        pose === null ? "" : ` (x ${pose.x}, y ${pose.y}, z ${pose.z})`
      }`
      summary.append(item)
    }
    const scroll = document.createElement("li")
    const rate = results.scroll
    scroll.textContent =
      rate === null || rate === "skipped"
        ? "scroll: skipped"
        : `scroll: at least ${String(rate.lowest)} readings a second while scrolling`
    summary.append(scroll)
    summary.hidden = false
    element("results").textContent = JSON.stringify(results, null, 2)
    element("results").hidden = false
    buttons.copy.hidden = false
    window.scrollTo(0, 0)
  }

  const asked = (access: MotionAccess): void => {
    results.permission.push(access)
    buttons.allow.hidden = true
    if (access.granted) {
      buttons.retry.hidden = true
      if (pageLocked) beginSteps()
      else askForRotationLock()
      return
    }
    say(
      "status",
      `The browser said no: ${access.code}, ${access.detail}. If a prompt appeared and you tapped Don't Allow, tap Ask again to see whether it asks a second time.`,
    )
    if (results.permission.length === 1) {
      buttons.retry.hidden = false
    } else {
      buttons.retry.hidden = true
      finish()
    }
  }

  // First thing in the tap, before anything is awaited: iOS asks only then.
  // Full screen is asked for in the same tap, because a browser locks the
  // screen's orientation only in full screen; where the lock is refused the
  // page leaves full screen and asks for the phone's own rotation lock.
  buttons.allow.addEventListener("click", () => {
    const motion = requestMotion()
    const kept = enterFullscreen().then(async (fullscreen) => {
      results.orientation.fullscreen = fullscreen
      if (fullscreen !== "entered") return
      results.orientation.portrait = await lockTo("portrait-primary")
      pageLocked = results.orientation.portrait === "locked"
      if (!pageLocked) leaveFullscreen()
    })
    void Promise.all([motion, kept]).then(([access]) => asked(access))
  })
  buttons.proceed.addEventListener("click", beginSteps)
  buttons.retry.addEventListener("click", () => {
    void requestMotion().then(asked)
  })
  buttons.skip.addEventListener("click", () => {
    if (phase === "scroll") {
      results.scroll = "skipped"
      finish()
      return
    }
    const step = STEPS[stepIndex]
    if (step !== undefined) next(judge(step, null))
  })
  buttons.copy.addEventListener("click", () => {
    const text = element("results").textContent ?? ""
    navigator.clipboard.writeText(text).then(
      () => say("status", "Copied. Paste it into the chat with Claude."),
      () => {
        const range = document.createRange()
        range.selectNodeContents(element("results"))
        getSelection()?.removeAllRanges()
        getSelection()?.addRange(range)
        say(
          "status",
          "Copying was refused: the text below is selected, so copy it by hand.",
        )
      },
    )
  })

  window.addEventListener(
    "scroll",
    () => {
      if (phase !== "scroll") return
      const now = performance.now()
      if (scrolledFrom === null) scrolledFrom = now
      scrolledTo = now
      const left = Math.ceil((SCROLL_MS - (now - scrolledFrom)) / 1000)
      say("status", left > 0 ? `Keep going: ${left} s` : "Got it.")
      if (now - scrolledFrom >= SCROLL_MS) {
        const from = scrolledFrom
        results.scroll = {
          seconds: Math.round((scrolledTo - from) / 100) / 10,
          ...readingRate(readingTimes, from, scrolledTo),
          before: readingRate(readingTimes, from - 3000, from),
        }
        finish()
      }
    },
    { passive: true },
  )

  setInterval(() => {
    const { x, y, z } = latest(host.live?.recorded() ?? [])
    say("live", `x ${x}, y ${y}, z ${z}  (angle ${String(screenAngle())})`)
    // Gravity across the screen, x right and y up, so the dot falls to
    // wherever down is.
    dot.style.left = `${50 + x / 2.2}%`
    dot.style.top = `${50 - y / 2.2}%`
    if (phase !== "step") return
    const step = STEPS[stepIndex]
    if (step === undefined) return
    if (turnedTooSoon(step, screenAngle(), portraitAngle)) {
      say(
        "status",
        "The screen turned. Turn rotation lock on, hold the phone upright until the screen turns back, then carry on.",
      )
      samples = []
      return
    }
    samples.push({
      at: performance.now(),
      x,
      y,
      z,
      ...raw,
      angle: screenAngle(),
      reported: reportedAngles(),
    })
    if (samples.length > 100) samples.splice(0, samples.length - 100)
    const pose = heldStill(samples)
    if (pose !== null && step.arrived(pose, portraitAngle))
      next(judge(step, pose))
  }, SAMPLE_MS)

  host.start()
}

try {
  start()
} catch (error) {
  say("status", error instanceof Error ? error.message : String(error))
}
