import { defineConfig } from "vite";

export default defineConfig({
  base: "./",
  build: {
    outDir: "../src/strata/static",
    emptyOutDir: true,
    copyPublicDir: false,
    target: "es2022",
    chunkSizeWarningLimit: 1500,
  },
  server: { port: 5173 },
});
