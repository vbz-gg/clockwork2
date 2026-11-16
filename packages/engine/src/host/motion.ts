/**
 * Asking for tilt, on the page a game runs in.
 *
 * iOS shows its permission prompt only from a tap, and refuses without
 * asking once anything has been awaited in that tap's handler. So a page
 * calls `requestMotion` first thing in its Play button's click, before it
 * starts a run, and starts the run only after the answer. Asked after a run
 * has started, the tap is spent, iOS refuses, and a ranked run is gone with
 * the game unsteerable. iOS remembers a refusal for the site until the
 * browser's website data is cleared, so a page cannot ask again: it tells the
 * player.
 *
 * Nothing here touches the browser when the module loads, so a page may
 * import it while rendering on a server.
 */

/** Why tilt is not available. Each is something to tell the player. */
export const MOTION_REFUSALS = {
  /** The page is not https (or localhost), and browsers give sensors only to a secure page. */
  INSECURE: "E_MOTION_INSECURE",
  /** This browser has no orientation events, or cannot say which way the screen is turned. */
  UNSUPPORTED: "E_MOTION_UNSUPPORTED",
  /** The player said no, or was asked outside a tap. */
  DENIED: "E_MOTION_DENIED",
  /** The page's own permissions policy forbids the sensors. */
  BLOCKED: "E_MOTION_BLOCKED",
  /** Nothing arrived: a laptop or a desktop with no tilt sensor. */
  NO_SENSOR: "E_MOTION_NO_SENSOR",
} as const

export type MotionRefusal =
  (typeof MOTION_REFUSALS)[keyof typeof MOTION_REFUSALS]

export type MotionAccess =
  | { readonly granted: true }
  | {
      readonly granted: false
      readonly code: MotionRefusal
      readonly detail: string
    }

/** The browser, for a test to stand in for. */
export interface MotionEnvironment {
  readonly window: EventTarget
  readonly isSecureContext: boolean
  /** `DeviceOrientationEvent`, and iOS's `requestPermission` on it. */
  readonly orientation:
    | { readonly requestPermission?: () => Promise<string> }
    | undefined
  /** `screenAngleOf` the page, or undefined where the browser has neither. */
  screenAngle(): number | undefined
  /** Whether the page's policy allows a sensor feature, where the browser can say. */
  allowsFeature(feature: string): boolean | undefined
  setTimeout(run: () => void, ms: number): unknown
  clearTimeout(handle: unknown): void
}

/** How long a grant waits for a first reading before it calls the device sensorless. */
export const MOTION_WAIT_MS = 1000

type PolicyLike = { allowsFeature?: (feature: string) => boolean }

/** The two places a browser says how far its screen is turned. */
export interface ScreenAngleSource {
  /** `window.orientation`, which iOS and Android browsers still have. */
  readonly orientation?: unknown
  readonly screen?: { readonly orientation?: { readonly angle?: number } }
}

/**
 * How far the screen is turned, in the frame `deviceorientation` readings
 * are measured in: `window.orientation` where the browser has it, and
 * `screen.orientation.angle` only where it does not.
 *
 * The two disagree on an iPad. Measured on an iPad Pro (2018) under iPadOS
 * Safari 26.6: held in portrait, `screen.orientation.angle` was 90 with a
 * type of "portrait-primary" and `window.orientation` 0; on its side, 180
 * and -90; loaded sideways, 0 and 90. Its readings matched
 * `window.orientation` every time, so Safari there measures the screen's
 * angle from landscape and the readings from portrait, and the screen's
 * angle turned every tilt a quarter the wrong way. On a Galaxy S24+ under
 * Chrome 157 the two agreed. A desktop browser has no `window.orientation`,
 * and there the screen's own angle is the only one.
 */
export function screenAngleOf(scope: ScreenAngleSource): number | undefined {
  if (typeof scope.orientation === "number") return scope.orientation
  return scope.screen?.orientation?.angle
}

/** `screenAngleOf` for this page. */
export function currentScreenAngle(): number | undefined {
  return screenAngleOf(globalThis as unknown as ScreenAngleSource)
}

export function motionEnvironment(): MotionEnvironment {
  const scope = globalThis as unknown as {
    readonly isSecureContext?: boolean
    readonly DeviceOrientationEvent?: MotionEnvironment["orientation"]
    readonly screen?: { readonly orientation?: { readonly angle?: number } }
    readonly document?: {
      readonly permissionsPolicy?: PolicyLike
      readonly featurePolicy?: PolicyLike
    }
  }
  return {
    window: globalThis,
    isSecureContext: scope.isSecureContext === true,
    orientation: scope.DeviceOrientationEvent,
    screenAngle: currentScreenAngle,
    allowsFeature: (feature) => {
      // Chromium alone can say; elsewhere a blocked sensor looks like no
      // sensor, which is what NO_SENSOR then reports.
      const policy =
        scope.document?.permissionsPolicy ?? scope.document?.featurePolicy
      return policy?.allowsFeature?.(feature)
    },
    setTimeout: (run, ms) => globalThis.setTimeout(run, ms),
    clearTimeout: (handle) =>
      globalThis.clearTimeout(handle as ReturnType<typeof setTimeout>),
  }
}

/** True for the four angles a screen can be turned to. */
export function isMotionAngle(
  angle: number | undefined,
): angle is 0 | 90 | 180 | 270 {
  return angle === 0 || angle === 90 || angle === 180 || angle === 270
}

function refused(code: MotionRefusal, detail: string): MotionAccess {
  return { granted: false, code, detail }
}

/**
 * Asks for tilt. Call it as the first thing a click handler does, before any
 * `await`: anything awaited first moves the request out of the tap, and iOS
 * then refuses without asking.
 *
 * Resolves `{ granted: true }` once a first real reading has arrived, so a
 * grant on a device with no sensor is reported as `E_MOTION_NO_SENSOR`
 * rather than as a game that reads a phone lying flat. Never rejects.
 */
export function requestMotion(
  options: {
    readonly wait?: number
    readonly environment?: MotionEnvironment
  } = {},
): Promise<MotionAccess> {
  const environment = options.environment ?? motionEnvironment()
  if (!environment.isSecureContext) {
    return Promise.resolve(
      refused(
        MOTION_REFUSALS.INSECURE,
        "tilt needs an https page, or localhost",
      ),
    )
  }
  const orientation = environment.orientation
  if (orientation === undefined || environment.screenAngle() === undefined) {
    return Promise.resolve(
      refused(
        MOTION_REFUSALS.UNSUPPORTED,
        "this browser has no orientation events or no screen angle",
      ),
    )
  }
  // The one call that can show a prompt, made before anything is awaited.
  const asked =
    typeof orientation.requestPermission === "function"
      ? orientation.requestPermission()
      : Promise.resolve("granted")
  return asked.then(
    (state) => {
      if (state !== "granted") {
        return refused(
          MOTION_REFUSALS.DENIED,
          `the browser answered ${JSON.stringify(state)}`,
        )
      }
      for (const feature of ["accelerometer", "gyroscope"]) {
        if (environment.allowsFeature(feature) === false) {
          return refused(
            MOTION_REFUSALS.BLOCKED,
            `the page's permissions policy forbids ${feature}`,
          )
        }
      }
      return firstReading(environment, options.wait ?? MOTION_WAIT_MS)
    },
    (reason: unknown) =>
      refused(
        MOTION_REFUSALS.DENIED,
        `asking for tilt failed: ${String(reason)}`,
      ),
  )
}

/**
 * The windows a real reading has already reached, by this or by the device
 * helpers. Chromium sends `deviceorientation` only when the reading changes,
 * so a phone held still while a game already listens sends nothing new, and
 * waiting for a reading then would report a working sensor as missing.
 */
const readingSeen = new WeakSet<object>()

/**
 * Notes a reading heard on `window`, and says whether it was a real one: sent
 * by the browser, with both angles. A device with no sensor sends readings
 * whose angles are null.
 */
export function noteReading(window: object, event: Event): boolean {
  const { beta, gamma } = event as DeviceOrientationEvent
  if (!event.isTrusted || beta === null || gamma === null) return false
  readingSeen.add(window)
  return true
}

function firstReading(
  environment: MotionEnvironment,
  wait: number,
): Promise<MotionAccess> {
  if (readingSeen.has(environment.window)) {
    return Promise.resolve({ granted: true })
  }
  return new Promise((resolve) => {
    const done = (access: MotionAccess): void => {
      environment.clearTimeout(timer)
      environment.window.removeEventListener("deviceorientation", onReading)
      resolve(access)
    }
    const onReading = (event: Event): void => {
      if (noteReading(environment.window, event)) done({ granted: true })
    }
    const timer = environment.setTimeout(() => {
      done(
        refused(
          MOTION_REFUSALS.NO_SENSOR,
          `no tilt reading arrived in ${wait} ms`,
        ),
      )
    }, wait)
    environment.window.addEventListener("deviceorientation", onReading)
  })
}
