import { defineConfig } from "vite-plus";
// v6 transforms JSX with oxc rather than Babel, which is where most of the
// build time used to go; the separate -oxc plugin is now folded into this one.
import react from "@vitejs/plugin-react";
import { fileURLToPath } from "node:url";

export default defineConfig({
  fmt: {
    // Prose and config files are left alone. The formatter pads Markdown tables
    // to a uniform width, which it measures in code points — so a table
    // containing Japanese or box-drawing characters ends up visually ragged in
    // the source even though the output renders fine.
    ignorePatterns: ["**/*.md", "**/*.yaml", "**/*.yml", "**/*.json"],
  },
  plugins: [react()],
  resolve: {
    alias: {
      "#shared": fileURLToPath(new URL("./shared", import.meta.url)),
    },
  },
  server: {
    port: 5273,
    proxy: {
      "/api": {
        target: "http://127.0.0.1:5274",
        changeOrigin: true,
        // The browser's Origin is :5273 while the API is :5274 in development.
        // Production remains strict; only the explicit dev origin is accepted.
      },
    },
  },
  build: { outDir: "dist", emptyOutDir: true },
});
