/**
 * The device helpers in a real browser.
 *
 * The unit suite drives `InputCapture` with fake events, which says what the
 * helpers do with an event and nothing about which events a browser sends.
 * Here `inputs.html` runs a game with every helper mapped, and each test
 * drives the browser the way a player would: Playwright's keyboard and
 * mouse, a stubbed `navigator.getGamepads`, and in Chromium an overridden
 * orientation sensor. Each reads back the log the page recorded and asserts
 * the inputs the test made are in it, so a page that silently records
 * nothing fails every test rather than passing them.
 *
 * Each step that must land on a tick of its own waits until the log shows
 * it. Without that, a browser that delivers a press and the move after it
 * inside one frame merges the two positions into one, in place before the
 * press (that is what a level does), and the log no longer shows where the
 * press landed. WebKit did exactly that when the steps were sent back to
 * back.
 */

import type { InputDeclaration } from "@clockwork2/engine"
import { type BrowserContext, expect, type Page, test } from "@playwright/test"
import { MANIFEST } from "../../demo/src/inputs/game"

type Logged = { tick: number; code: string; value: number }

function declared(name: string): InputDeclaration {
  const declaration = MANIFEST.inputs[name]
  if (declaration === undefined) throw new Error(`${name} is not declared`)
  return declaration
}

/** The ranges the page's game declares, which every expected value is in. */
const ACROSS = declared("touchX")
const DOWN = declared("touchY")
const ZOOM = declared("zoom")

async function recorded(page: Page): Promise<Logged[]> {
  return JSON.parse((await page.locator("#log").textContent()) ?? "[]")
}

/** Waits until the log holds `code` at `value`, and returns the whole log. */
async function until(
  page: Page,
  code: string,
  value: number,
): Promise<Logged[]> {
  await expect
    .poll(async () =>
      (await recorded(page)).some((e) => e.code === code && e.value === value),
    )
    .toBe(true)
  return recorded(page)
}

async function open(page: Page, query = ""): Promise<void> {
  await page.goto(`/inputs.html${query}`)
  await expect(page.locator("#phase")).toHaveText("running")
}

/** A point `fx`, `fy` of the way across the stage, in page pixels. */
async function across(
  page: Page,
  fx: number,
  fy: number,
): Promise<{ x: number; y: number }> {
  const box = await page.locator("#stage").boundingBox()
  if (box === null) throw new Error("the stage is not on the page")
  return { x: box.x + fx * box.width, y: box.y + fy * box.height }
}

/** What a helper records for `fraction` of the way across a range. */
function inRange(range: InputDeclaration, fraction: number): number {
  return Math.round(range.min + fraction * (range.max - range.min))
}

const pairs = (log: readonly Logged[]) =>
  log.map(({ code, value }) => [code, value] as const)

test.describe("the device helpers in a browser", () => {
  test("a key press and release are recorded without clicking the game first, and an unmapped key records nothing", async ({
    page,
  }) => {
    await open(page)
    await page.keyboard.press("KeyQ")
    await page.keyboard.press("ArrowLeft")
    const log = await until(page, "left", 0)
    expect(pairs(log)).toEqual([
      ["left", 1],
      ["left", 0],
    ])
  })

  test("a key event a script dispatches is not the player's, unless the page records scripted events", async ({
    page,
  }) => {
    // The browser marks an event a script made with isTrusted false, and the
    // helpers ignore one unless the page asks for scripted events: a ranked
    // run's page ignores them, so no script on it can press for the player.
    const scripted = () =>
      page.evaluate(() => {
        for (const type of ["keydown", "keyup"]) {
          window.dispatchEvent(new KeyboardEvent(type, { code: "ArrowLeft" }))
        }
      })
    await open(page)
    await scripted()
    await page.keyboard.press("KeyD")
    const ignored = await until(page, "right", 0)
    expect(pairs(ignored)).toEqual([
      ["right", 1],
      ["right", 0],
    ])

    await open(page, "?scripted=record")
    await scripted()
    const kept = await until(page, "left", 0)
    expect(pairs(kept)).toEqual([
      ["left", 1],
      ["left", 0],
    ])
  })

  // The pointer tests leave mouse lock out of the mapping: Chromium and
  // Firefox grant the lock headless, and a locked mouse reports movement,
  // not a position, and cannot leave the stage.
  test("a pointer press records its position before the press, in the declared range", async ({
    page,
  }) => {
    await open(page, "?lock=off")
    const at = await across(page, 0.25, 0.75)
    await page.mouse.move(at.x, at.y)
    // Moving with nothing pressed is hover, a position of its own.
    await until(page, "hoverY", inRange(declared("hoverY"), 0.75))
    await page.mouse.down()
    const log = await until(page, "touch", 1)
    const press = log.findIndex((e) => e.code === "touch" && e.value === 1)
    const tick = (log[press] as Logged).tick
    const before = log.slice(0, press).filter((e) => e.tick === tick)
    expect(pairs(before)).toEqual([
      ["touchX", inRange(ACROSS, 0.25)],
      ["touchY", inRange(DOWN, 0.75)],
    ])
    expect(pairs(log.slice(0, press))).toContainEqual([
      "hoverX",
      inRange(declared("hoverX"), 0.25),
    ])
    await page.mouse.up()
    await until(page, "touch", 0)
  })

  test("a press that slides off the game and is let go outside it is released, because the pointer is captured", async ({
    page,
  }) => {
    await open(page, "?lock=off")
    const start = await across(page, 0.5, 0.5)
    await page.mouse.move(start.x, start.y)
    await page.mouse.down()
    await until(page, "touch", 1)
    const outside = await across(page, 0.5, 1.4)
    await page.mouse.move(outside.x, outside.y)
    // Only a captured pointer is heard by the stage once it has left it, so
    // a position held at the bottom of its range is the capture working.
    await until(page, "touchY", DOWN.max)
    await page.mouse.up()
    const log = await until(page, "touch", 0)
    expect(pairs(log.filter((e) => e.code === "touch"))).toEqual([
      ["touch", 1],
      ["touch", 0],
    ])
  })

  test("a chord: the right button's press and release are recorded inside a main press, and the menu stays shut", async ({
    page,
  }) => {
    await open(page, "?lock=off")
    // Heard after the stage's own listener, so it sees whether the helper
    // kept the browser's menu shut.
    await page.evaluate(() => {
      document.addEventListener("contextmenu", (event) => {
        const seen = document.body.dataset.menus ?? ""
        document.body.dataset.menus = `${seen}${event.defaultPrevented ? "shut" : "open"} `
      })
    })
    const at = await across(page, 0.5, 0.5)
    await page.mouse.move(at.x, at.y)
    await page.mouse.down({ button: "left" })
    await until(page, "touch", 1)
    await page.mouse.down({ button: "right" })
    await until(page, "alt", 1)
    await page.mouse.up({ button: "right" })
    await until(page, "alt", 0)
    await page.mouse.up({ button: "left" })
    const log = await until(page, "touch", 0)
    expect(
      pairs(log.filter((e) => e.code === "touch" || e.code === "alt")),
    ).toEqual([
      ["touch", 1],
      ["alt", 1],
      ["alt", 0],
      ["touch", 0],
    ])
    await expect(page.locator("body")).toHaveAttribute(
      "data-menus",
      /^(shut )+$/,
    )
  })

  test("the wheel's pixels become whole notches, held to the declared range", async ({
    page,
  }) => {
    await open(page)
    // What the browser reported, read mode first as Firefox needs.
    await page.evaluate(() => {
      document.querySelector("#stage")?.addEventListener("wheel", (event) => {
        const wheel = event as WheelEvent
        const seen = document.body.dataset.wheel ?? ""
        document.body.dataset.wheel = `${seen}${wheel.deltaMode}:${wheel.deltaY} `
      })
    })
    const at = await across(page, 0.5, 0.5)
    await page.mouse.move(at.x, at.y)
    for (let i = 0; i < 3; i++) {
      await page.mouse.wheel(0, 250)
      await page.waitForTimeout(50)
    }
    await expect(page.locator("body")).toHaveAttribute(
      "data-wheel",
      "0:250 0:250 0:250 ",
    )
    // 750 pixels at 100 to a notch: seven notches, the half carried.
    await expect
      .poll(async () =>
        (await recorded(page))
          .filter((e) => e.code === "zoom")
          .reduce((sum, e) => sum + e.value, 0),
      )
      .toBe(7)
    const spun = (await recorded(page)).filter((e) => e.code === "zoom")
    expect(spun.length).toBeGreaterThan(0)

    // A flick of fifty notches records the end of the range on the tick it
    // lands, carries one range's width into the ticks after, and drops the
    // rest: -10 three times.
    await page.mouse.wheel(0, -5000)
    const width = ZOOM.max - ZOOM.min
    await expect
      .poll(async () =>
        (await recorded(page))
          .filter((e) => e.code === "zoom")
          .slice(spun.length)
          .map((e) => e.value),
      )
      .toEqual(Array.from({ length: 1 + width / ZOOM.max }, () => ZOOM.min))
    for (const e of (await recorded(page)).filter((e) => e.code === "zoom")) {
      expect(Number.isInteger(e.value)).toBe(true)
      expect(e.value).toBeGreaterThanOrEqual(ZOOM.min)
      expect(e.value).toBeLessThanOrEqual(ZOOM.max)
    }
  })

  // Measured headless, with Playwright's own mouse, which moves to absolute
  // positions: Chromium and Firefox grant the lock from a press, and WebKit
  // refuses it because its window never has focus.
  const LOCKS: Readonly<Record<string, boolean>> = {
    chromium: true,
    firefox: true,
    webkit: false,
  }

  test("a press asks for the mouse lock, and a refusal arrives as a device notice", async ({
    page,
    browserName,
  }) => {
    await open(page)
    const at = await across(page, 0.5, 0.5)
    await page.mouse.move(at.x, at.y)
    await page.mouse.down()
    await until(page, "touch", 1)
    await page.mouse.up()
    // Whether or not it locked, the press is the game's and comes up.
    await until(page, "touch", 0)
    if (LOCKS[browserName] !== true) {
      await expect(page.locator("#notices")).toContainText(
        "E_POINTER_LOCK_REFUSED",
      )
      await expect(page.locator("#locked")).toHaveText("no")
      return
    }
    await expect(page.locator("#locked")).toHaveText("yes")
    await expect(page.locator("#notices")).toHaveText("[]")
    if (browserName !== "firefox") return
    // Under the lock Firefox measures each synthetic move from the middle of
    // the viewport, where it parks the locked cursor, so a move to the middle
    // plus (10, 4) is a movement of (10, 4). Chromium headless reports each
    // synthetic move as the move and its reverse, which cancel, and just
    // after the lock a movement of minus the cursor's last position, which
    // the helper records as lookX and lookY at the bottom of their range; so
    // it has no movement worth measuring here.
    const viewport = page.viewportSize()
    if (viewport === null) throw new Error("the page has no viewport")
    const middle = { x: viewport.width / 2, y: viewport.height / 2 }
    for (const step of [1, 2, 3]) {
      await page.mouse.move(middle.x + 10 * step, middle.y + 4 * step)
    }
    const total = async (code: string) =>
      (await recorded(page))
        .filter((e) => e.code === code)
        .reduce((sum, e) => sum + e.value, 0)
    await expect.poll(() => total("lookX")).toBe(60)
    await expect.poll(() => total("lookY")).toBe(24)
  })

  test("a game in a frame that may not lock the mouse reports the refusal as a device notice", async ({
    page,
    baseURL,
  }) => {
    // Firefox answers the request with nothing and says no only with a
    // pointerlockerror on the document; WebKit says no both ways. Each
    // refusal is one notice.
    if (baseURL === undefined) throw new Error("the suite has no baseURL")
    // Scripts and the same origin are allowed, and the lock is not, which is
    // how a page embeds a game it does not want locking the mouse.
    await page.setContent(
      `<iframe sandbox="allow-scripts allow-same-origin" src="${baseURL}/inputs.html" style="position:absolute;left:0;top:0;width:1240px;height:680px;border:0"></iframe>`,
    )
    const frame = page.frameLocator("iframe")
    await expect(frame.locator("#phase")).toHaveText("running")
    const box = await frame.locator("#stage").boundingBox()
    if (box === null) throw new Error("the stage is not in the frame")
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2)
    await page.mouse.down()
    await page.mouse.up()
    await expect
      .poll(async () =>
        JSON.parse((await frame.locator("#log").textContent()) ?? "[]"),
      )
      .toContainEqual(expect.objectContaining({ code: "touch", value: 0 }))
    // The browser did refuse: the page heard it say so.
    await expect(frame.locator("#lock-errors")).not.toHaveText("0")
    await expect(frame.locator("#locked")).toHaveText("no")
    await expect(frame.locator("#notices")).toContainText(
      "E_POINTER_LOCK_REFUSED",
      { timeout: 3000 },
    )
  })

  test("a controller's button and stick reach the log, and unplugging it releases and centres", async ({
    page,
  }) => {
    // A controller nobody has to plug in: the helper reads it with
    // navigator.getGamepads once a frame, and this answers that call.
    await page.addInitScript(() => {
      const pads: (object | null)[] = [null, null, null, null]
      Object.defineProperty(Navigator.prototype, "getGamepads", {
        configurable: true,
        value: () => pads.slice(),
      })
      Object.defineProperty(window, "plugPad", {
        value: (pad: object | null) => {
          pads[0] = pad
        },
      })
    })
    await open(page)
    const plug = (pad: object | null) =>
      page.evaluate((next) => {
        ;(window as unknown as { plugPad(pad: object | null): void }).plugPad(
          next,
        )
      }, pad)
    // A standard pad with A down, the right trigger half in, and the left
    // stick at 0.54 right and up: past the 0.08 deadzone that rescales to
    // half, so 50 in a range of -100 to 100.
    await plug({
      index: 0,
      id: "stub pad",
      mapping: "standard",
      connected: true,
      timestamp: 0,
      buttons: Array.from({ length: 17 }, (_, b) => ({
        pressed: b === 0,
        touched: b === 0,
        value: b === 0 ? 1 : b === 7 ? 0.5 : 0,
      })),
      axes: [0.54, -0.54, 0, 0],
    })
    const plugged = await until(page, "padY", -50)
    expect(pairs(plugged)).toEqual([
      ["padA", 1],
      ["padTrigger", 5],
      ["padX", 50],
      ["padY", -50],
    ])
    await plug(null)
    const log = await until(page, "padTrigger", 0)
    expect(pairs(log.slice(plugged.length))).toEqual([
      ["padA", 0],
      ["padX", 0],
      ["padY", 0],
      ["padTrigger", 0],
    ])
    await expect(page.locator("#notices")).toHaveText("[]")
  })

  test("tilt, from Chromium's orientation override", async ({
    page,
    context,
    browserName,
  }) => {
    test.skip(
      browserName !== "chromium",
      "Firefox and WebKit have no sensor override in Playwright",
    )
    // Without the grant Chromium sends one reading with every angle null and
    // nothing after, which the helper rightly drops.
    await context.grantPermissions(["accelerometer", "gyroscope"])
    const cdp = await context.newCDPSession(page)
    await open(page)
    const turn = (beta: number, gamma: number) =>
      cdp.send("DeviceOrientation.setDeviceOrientationOverride", {
        alpha: 0,
        beta,
        gamma,
      })
    // Flat, right edge tipped down 30 degrees: half of gravity to the right,
    // and cos 30 of it into the table.
    await turn(0, 30)
    const flat = await until(page, "tiltZ", -87)
    expect(pairs(flat)).toEqual([
      ["tiltX", 50],
      ["tiltY", 0],
      ["tiltZ", -87],
    ])
    // Held upright: gravity points down the screen.
    await turn(90, 0)
    const upright = await until(page, "tiltY", -100)
    expect(pairs(upright.slice(flat.length))).toEqual([
      ["tiltX", 0],
      ["tiltY", -100],
      ["tiltZ", 0],
    ])

    // Asked while the device holds still. Chromium sends a reading only when
    // it changes, so none arrives now; the reading the helper already heard
    // is what says the sensor works. Before that counted, this answered
    // E_MOTION_NO_SENSOR.
    await page.locator("#motion").click()
    await expect(page.locator("#motion-access")).toHaveText(
      JSON.stringify({ granted: true }),
    )
  })

  test("tilt follows the orientation's name where the screen's own angle disagrees, as an iPad's does", async ({
    page,
    context,
    browserName,
  }) => {
    test.skip(
      browserName !== "chromium",
      "Firefox and WebKit have no sensor override in Playwright",
    )
    // What an iPad Pro (2018) under iPadOS Safari 26.6 said held in
    // portrait: the type portrait-primary, the screen's angle 90,
    // window.orientation 0, and readings measured against 0.
    await page.addInitScript(() => {
      Object.defineProperty(ScreenOrientation.prototype, "angle", {
        get: () => 90,
      })
      Object.defineProperty(ScreenOrientation.prototype, "type", {
        get: () => "portrait-primary",
      })
      Object.defineProperty(window, "orientation", { get: () => 0 })
    })
    await context.grantPermissions(["accelerometer", "gyroscope"])
    const cdp = await context.newCDPSession(page)
    await open(page)
    await cdp.send("DeviceOrientation.setDeviceOrientationOverride", {
      alpha: 0,
      beta: 90,
      gamma: 0,
    })
    // Upright is gravity down the screen. Turned by the screen's own angle
    // it would read as gravity across it, tiltX -100.
    const upright = await until(page, "tiltY", -100)
    expect(pairs(upright)).toEqual([
      ["tiltX", 0],
      ["tiltY", -100],
      ["tiltZ", 0],
    ])
  })

  /**
   * Walks the tilt check from its first tap to its copied results, holding
   * each pose with Chromium's orientation override. `locks` says whether the
   * page may lock the screen's orientation: Chromium lets it, the way Android
   * Chrome does, and the other walk takes the lock away, the way Safari has
   * none, so the page asks for the device's own rotation lock instead.
   */
  async function walkTiltCheck(
    page: Page,
    context: BrowserContext,
    locks: boolean,
  ) {
    await context.grantPermissions([
      "accelerometer",
      "gyroscope",
      "clipboard-read",
      "clipboard-write",
    ])
    if (!locks) {
      await page.addInitScript(() => {
        Object.defineProperty(ScreenOrientation.prototype, "lock", {
          value: () =>
            Promise.reject(
              new DOMException("no lock here", "NotSupportedError"),
            ),
        })
      })
    }
    const cdp = await context.newCDPSession(page)
    await page.goto("/tilt.html")
    const turn = (beta: number, gamma: number) =>
      cdp.send("DeviceOrientation.setDeviceOrientationOverride", {
        alpha: 0,
        beta,
        gamma,
      })
    const instruction = page.locator("#instruction")
    // Lying flat with its right edge a little low, which the flat step takes.
    await turn(0, 5)
    await page.locator("#allow").click()
    if (!locks) {
      await expect(instruction).toContainText("rotation lock")
      await page.locator("#continue").click()
    }
    await expect(instruction).toContainText("upright")
    await turn(90, 0)
    await expect(instruction).toContainText("steering wheel")
    // Upright with the right edge lowered 30 degrees: gravity is half to the
    // right and cos 30 down the screen. Chromium refuses a gamma of 90.
    await turn(60, 89.9)
    await expect(instruction).toContainText("on its side")
    // Sideways: the screen's axes turn with it, so held upright on its side
    // is gravity along the device's own -x and down the screen.
    await cdp.send("Emulation.setDeviceMetricsOverride", {
      width: 844,
      height: 390,
      deviceScaleFactor: 1,
      mobile: true,
      screenOrientation: { type: "landscapePrimary", angle: 90 },
    })
    await turn(0, -90)
    await expect(instruction).toContainText("Still on its side")
    await turn(30, -90)
    await expect(instruction).toContainText("Scroll this page")
    // Scrolled with the device moving, so readings keep arriving.
    for (let i = 0; i < 40 && !(await page.locator("#copy").isVisible()); i++) {
      await turn(30 + (i % 5), -90)
      await page.mouse.wheel(0, i % 2 === 0 ? 300 : -300)
      await page.waitForTimeout(100)
    }
    await expect(page.locator("#copy")).toBeVisible()
    const results = JSON.parse(
      (await page.locator("#results").textContent()) ?? "{}",
    ) as {
      permission: unknown[]
      steps: { id: string; outcome: string }[]
      scroll: { lowest: number }
      orientation: { portrait: string; landscape: string; byHand: boolean }
    }
    expect(results.permission).toEqual([{ granted: true }])
    expect(results.steps.map((step) => [step.id, step.outcome])).toEqual([
      ["flat", "passed"],
      ["upright", "passed"],
      ["steer", "passed"],
      ["sideways", "passed"],
      ["sidewaysSteer", "passed"],
    ])
    expect(results.scroll.lowest).toBeGreaterThan(0)
    await page.locator("#copy").click()
    await expect(page.locator("#status")).toContainText("Copied")
    const copied = await page.evaluate(() => navigator.clipboard.readText())
    expect(JSON.parse(copied)).toEqual(results)
    return results
  }

  test("the tilt check locks the screen itself where it can, walks every pose, and copies what it found", async ({
    page,
    context,
    browserName,
  }) => {
    test.skip(
      browserName !== "chromium",
      "Firefox and WebKit have no sensor override in Playwright",
    )
    const results = await walkTiltCheck(page, context, true)
    expect(results.orientation).toMatchObject({
      portrait: "locked",
      landscape: "locked",
      byHand: false,
    })
  })

  test("the tilt check's scroll step alone, from ?step=scroll, hears the page scrolling", async ({
    page,
    context,
    browserName,
  }) => {
    test.skip(
      browserName !== "chromium",
      "Firefox and WebKit have no sensor override in Playwright",
    )
    await context.grantPermissions(["accelerometer", "gyroscope"])
    const cdp = await context.newCDPSession(page)
    await page.goto("/tilt.html?step=scroll")
    const turn = (beta: number) =>
      cdp.send("DeviceOrientation.setDeviceOrientationOverride", {
        alpha: 0,
        beta,
        gamma: 0,
      })
    await turn(10)
    await page.locator("#allow").click()
    await expect(page.locator("#instruction")).toContainText("Scroll this page")
    for (let i = 0; i < 40 && !(await page.locator("#copy").isVisible()); i++) {
      await turn(10 + (i % 5))
      await page.mouse.wheel(0, i % 2 === 0 ? 300 : -300)
      await page.waitForTimeout(100)
    }
    const results = JSON.parse(
      (await page.locator("#results").textContent()) ?? "{}",
    ) as {
      steps: unknown[]
      scroll: { lowest: number; heard: { scroll: number } }
    }
    expect(results.steps).toEqual([])
    expect(results.scroll.heard.scroll).toBeGreaterThan(0)
    expect(results.scroll.lowest).toBeGreaterThan(0)
  })

  test("where the screen cannot be locked, the tilt check asks for the device's own rotation lock", async ({
    page,
    context,
    browserName,
  }) => {
    test.skip(
      browserName !== "chromium",
      "Firefox and WebKit have no sensor override in Playwright",
    )
    const results = await walkTiltCheck(page, context, false)
    expect(results.orientation.byHand).toBe(true)
    expect(results.orientation.portrait).toContain("NotSupportedError")
  })

  // Measured headless on a desktop: Chromium and Firefox have the events and
  // no sensor behind them, and WebKit has no DeviceOrientationEvent at all.
  const NO_TILT: Readonly<Record<string, string>> = {
    chromium: "E_MOTION_NO_SENSOR",
    firefox: "E_MOTION_NO_SENSOR",
    webkit: "E_MOTION_UNSUPPORTED",
  }

  test("asking for tilt where there is no sensor says why, and records nothing", async ({
    page,
    browserName,
  }) => {
    await open(page)
    await page.locator("#motion").click()
    await expect(page.locator("#motion-access")).toContainText(
      `"code":"${NO_TILT[browserName]}"`,
    )
    expect(
      (await recorded(page)).filter((e) => e.code.startsWith("tilt")),
    ).toEqual([])
  })
})
