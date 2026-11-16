import { describe, expect, test } from "bun:test"
import {
  MOTION_REFUSALS,
  type MotionEnvironment,
  noteReading,
  requestMotion,
} from "../../src/host/motion"

/** A browser to ask, every part of it a fake. */
function browser(overrides: Partial<MotionEnvironment> = {}) {
  const listeners = new Set<(event: unknown) => void>()
  const timers: Array<() => void> = []
  const order: string[] = []
  const environment: MotionEnvironment = {
    window: {
      addEventListener: (_type: string, listener: unknown) => {
        listeners.add(listener as (event: unknown) => void)
      },
      removeEventListener: (_type: string, listener: unknown) => {
        listeners.delete(listener as (event: unknown) => void)
      },
      dispatchEvent: () => true,
    },
    isSecureContext: true,
    orientation: {},
    screenAngle: () => 0,
    allowsFeature: () => undefined,
    setTimeout: (run) => {
      timers.push(run)
      return timers.length
    },
    clearTimeout: () => undefined,
    ...overrides,
  }
  return {
    environment,
    order,
    listeners,
    reading(beta: number | null, gamma: number | null, isTrusted = true) {
      for (const listener of [...listeners])
        listener({ isTrusted, beta, gamma })
    },
    timeout() {
      for (const run of timers.splice(0)) run()
    },
  }
}

describe("asking for tilt", () => {
  test("is granted once a first real reading arrives", async () => {
    const b = browser()
    const asked = requestMotion({ environment: b.environment })
    await Promise.resolve()
    b.reading(10, 5)
    expect(await asked).toEqual({ granted: true })
    // And it stops listening once it knows.
    expect(b.listeners.size).toBe(0)
  })

  test("asks iOS for permission before anything is awaited", () => {
    // Anything awaited first moves the request out of the tap, and iOS then
    // refuses without asking.
    const order: string[] = []
    const b = browser({
      orientation: {
        requestPermission: () => {
          order.push("asked")
          return Promise.resolve("granted")
        },
      },
    })
    void requestMotion({ environment: b.environment })
    order.push("returned")
    expect(order).toEqual(["asked", "returned"])
  })

  test("a page that is not https is told why before anything is asked", async () => {
    let asked = false
    const b = browser({
      isSecureContext: false,
      orientation: {
        requestPermission: () => {
          asked = true
          return Promise.resolve("granted")
        },
      },
    })
    const access = await requestMotion({ environment: b.environment })
    expect(access).toMatchObject({
      granted: false,
      code: MOTION_REFUSALS.INSECURE,
    })
    expect(asked).toBe(false)
  })

  test("a browser with no orientation events, or no screen angle, is unsupported", async () => {
    for (const overrides of [
      { orientation: undefined },
      { screenAngle: () => undefined },
    ]) {
      const access = await requestMotion({
        environment: browser(overrides).environment,
      })
      expect(access).toMatchObject({
        granted: false,
        code: MOTION_REFUSALS.UNSUPPORTED,
      })
    }
  })

  test("a player who says no, or a request that fails, is denied", async () => {
    for (const requestPermission of [
      () => Promise.resolve("denied"),
      () => Promise.reject(new Error("NotAllowedError")),
    ]) {
      const access = await requestMotion({
        environment: browser({ orientation: { requestPermission } })
          .environment,
      })
      expect(access).toMatchObject({
        granted: false,
        code: MOTION_REFUSALS.DENIED,
      })
    }
  })

  test("a page whose policy forbids the sensors is blocked, where the browser can say", async () => {
    const access = await requestMotion({
      environment: browser({
        allowsFeature: (feature) => feature !== "gyroscope",
      }).environment,
    })
    expect(access).toMatchObject({
      granted: false,
      code: MOTION_REFUSALS.BLOCKED,
    })
  })

  test("is granted at once where a real reading already arrived, as Chromium sends none for a phone held still", async () => {
    const b = browser()
    const first = requestMotion({ environment: b.environment })
    await Promise.resolve()
    b.reading(10, 5)
    expect(await first).toEqual({ granted: true })
    // Asked again with the phone still: no new reading, and no wait for one.
    const again = requestMotion({ environment: b.environment, wait: 50 })
    await Promise.resolve()
    b.timeout()
    expect(await again).toEqual({ granted: true })
    expect(b.listeners.size).toBe(0)
  })

  test("a reading the device helpers heard counts, and an empty or untrusted one does not", async () => {
    const window = browser().environment.window
    expect(
      noteReading(window, { isTrusted: true, beta: null, gamma: 3 } as never),
    ).toBe(false)
    expect(
      noteReading(window, { isTrusted: false, beta: 1, gamma: 3 } as never),
    ).toBe(false)
    const b = browser({ window })
    const empty = requestMotion({ environment: b.environment, wait: 50 })
    await Promise.resolve()
    b.timeout()
    expect(await empty).toMatchObject({ code: MOTION_REFUSALS.NO_SENSOR })
    expect(
      noteReading(window, { isTrusted: true, beta: 1, gamma: 3 } as never),
    ).toBe(true)
    expect(await requestMotion({ environment: b.environment })).toEqual({
      granted: true,
    })
  })

  test("a device that sends nothing, or only empty readings, has no sensor", async () => {
    // A desktop with no sensor fires readings with no angles. Granting tilt
    // there would hand the game a phone lying flat that nobody holds.
    const b = browser()
    const asked = requestMotion({ environment: b.environment, wait: 50 })
    await Promise.resolve()
    b.reading(null, null)
    b.reading(10, 10, false)
    b.timeout()
    expect(await asked).toMatchObject({
      granted: false,
      code: MOTION_REFUSALS.NO_SENSOR,
      detail: "no tilt reading arrived in 50 ms",
    })
    expect(b.listeners.size).toBe(0)
  })
})
