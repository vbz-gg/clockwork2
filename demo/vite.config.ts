import { resolve } from "node:path"
import { defineConfig } from "vite"

export default defineConfig({
  base: "./",
  // Workspace packages expose a "development" condition pointing at their
  // sources, so the dev server resolves them through the real exports map
  // rather than through an alias that bypasses it. Clockwork 1's demo aliased
  // straight at src, so it never exercised the published surface at all.
  resolve: { conditions: ["development"] },
  server: {
    port: 5173,
    strictPort: true,
  },
  preview: {
    port: 4173,
    strictPort: true,
  },
  worker: { format: "es" },
  build: {
    outDir: "dist",
    sourcemap: true,
    emptyOutDir: true,
    // `index` plays Snake directly in its page, the way a game runs on its
    // own site. The other two are a game with data packs, played in a page
    // and in a worker; the end-to-end suite plays both and replays them on a
    // server. `inputs` maps every device helper onto a game's inputs, for
    // the suite to drive with real keys, a mouse, the wheel, a stubbed
    // controller and an overridden sensor.
    rollupOptions: {
      input: {
        index: resolve(import.meta.dirname, "index.html"),
        packs: resolve(import.meta.dirname, "packs.html"),
        "packs-worker": resolve(import.meta.dirname, "packs-worker.html"),
        inputs: resolve(import.meta.dirname, "inputs.html"),
      },
      // One chunk per entry keeps the check that a production build carries no
      // test hooks simple: there is one place to look.
      output: { manualChunks: undefined },
    },
  },
})
