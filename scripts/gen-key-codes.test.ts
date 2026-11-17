import { describe, expect, test } from "bun:test"
import { KEY_CODES } from "../packages/engine/src/key-codes"
import { codesIn, render, SOURCE } from "./gen-key-codes"

describe("the key list's generator", () => {
  test("reads each row's anchor, once, sorted, without Unidentified", () => {
    const html = `
      <td><code class="code" id="code-KeyB">"KeyB"</code></td>
      <td><code class="code" id="code-Unidentified">"Unidentified"</code></td>
      <td><code class="code" id="code-KeyA">"KeyA"</code></td>
      <a href="#code-KeyA">KeyA</a>
      <td><code class="code" id="code-KeyA">"KeyA"</code></td>`
    expect(codesIn(html)).toEqual(["KeyA", "KeyB"])
  })

  test("the committed list is what the generator writes for it", async () => {
    // A hand edit to the generated file would leave it and the generator
    // describing two different lists.
    const committed = await Bun.file(
      new URL("../packages/engine/src/key-codes.ts", import.meta.url),
    ).text()
    expect(render(KEY_CODES)).toBe(committed)
    expect(committed).toContain(SOURCE)
  })
})
