import { resolve } from "node:path"
import { defineConfig } from "vite"

export default defineConfig({
  base: "./",
  // Workspace packages expose a "development" condition pointing at their
  // sources, so the dev server resolves them through the real exports map
  // rather than through an alias that bypasses it. Clockwork 1's demo aliased
  // straight at src, so it never exercised the published surface at all.
  resolve: { conditions: ["development"] },
  /**
   * A sandboxed frame has no `allow-same-origin`, so its origin is "null" and
   * every script it loads - including its own, from the very host that served
   * the document - is a cross-origin request. Vite answers with
   * `Access-Control-Allow-Origin: <the dev server's origin>`, which "null"
   * never matches, so the frame loads nothing and fails silently: no error in
   * the parent, no ready message, a blank game.
   *
   * Any host serving game bundles to a sandboxed frame has to do this,
   * production included.
   */
  server: {
    port: 5173,
    strictPort: true,
    headers: { "Access-Control-Allow-Origin": "*" },
  },
  preview: {
    port: 4173,
    strictPort: true,
    headers: { "Access-Control-Allow-Origin": "*" },
  },
  build: {
    outDir: "dist",
    sourcemap: true,
    emptyOutDir: true,
    // Three pages. `index` plays Snake directly, the way a developer does
    // while building it. `embed` and `frame` are the two halves of the way a
    // platform runs someone else's game: a host page and a sandboxed document
    // that talk over the bridge and share nothing else.
    rollupOptions: {
      input: {
        index: resolve(import.meta.dirname, "index.html"),
        embed: resolve(import.meta.dirname, "embed.html"),
        frame: resolve(import.meta.dirname, "frame.html"),
      },
      // One chunk per entry keeps the check that a production build carries no
      // test hooks simple: there is one place to look.
      output: { manualChunks: undefined },
    },
  },
})
