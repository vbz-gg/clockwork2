import { defineConfig } from "vite"

export default defineConfig({
  base: "./",
  // Workspace packages expose a "development" condition pointing at their
  // sources, so the dev server resolves them through the real exports map
  // rather than through an alias that bypasses it. Clockwork 1's demo aliased
  // straight at src, so it never exercised the published surface at all.
  resolve: { conditions: ["development"] },
  server: { port: 5173, strictPort: true },
  preview: { port: 4173, strictPort: true },
  build: {
    outDir: "dist",
    sourcemap: true,
    emptyOutDir: true,
    // One chunk per entry keeps the check that a production build carries no
    // test hooks simple: there is one place to look.
    rollupOptions: { output: { manualChunks: undefined } },
  },
})
