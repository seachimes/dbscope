import { defineConfig } from "vite-plus";
// v6 transforms JSX with oxc rather than Babel, which is where most of the
// build time used to go; the separate -oxc plugin is now folded into this one.
import react from "@vitejs/plugin-react";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

/**
 * The release tag the UI was built from. The release workflow builds on a tag
 * push from a shallow clone without tags, so GITHUB_REF_NAME is the source
 * there; package.json's version is not bumped per release.
 */
function buildVersion(): string {
  if (process.env.GITHUB_REF_TYPE === "tag" && process.env.GITHUB_REF_NAME) {
    return process.env.GITHUB_REF_NAME;
  }
  try {
    return execFileSync("git", ["describe", "--tags", "--always", "--dirty"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    return "dev";
  }
}

export default defineConfig({
  fmt: {
    // Prose and config files are left alone. The formatter pads Markdown tables
    // to a uniform width, which it measures in code points — so a table
    // containing Japanese or box-drawing characters ends up visually ragged in
    // the source even though the output renders fine.
    ignorePatterns: ["**/*.md", "**/*.yaml", "**/*.yml", "**/*.json"],
  },
  plugins: [react()],
  define: { __DBSCOPE_VERSION__: JSON.stringify(buildVersion()) },
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
