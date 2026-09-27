/**
 * Shared Chromium launcher for the verification scripts.
 *
 * playwright-core ships no browser of its own, so the executable is located
 * here in one place: an explicit CHROME_PATH first, then the standard
 * Playwright cache, then the usual system installs. Failing with a clear
 * message beats each script hardcoding a path that only exists on one machine.
 */
import { chromium } from "playwright-core";
import { existsSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

function fromPlaywrightCache() {
  const cache = process.env.PLAYWRIGHT_BROWSERS_PATH ?? join(homedir(), ".cache", "ms-playwright");
  if (!existsSync(cache)) return [];

  // Directory names carry a build number, so newest-first avoids pinning one.
  return readdirSync(cache)
    .filter((entry) => entry.startsWith("chromium"))
    .sort()
    .reverse()
    .flatMap((entry) => [
      join(cache, entry, "chrome-linux", "chrome"),
      join(cache, entry, "chrome-linux64", "chrome"),
      join(cache, entry, "chrome-headless-shell-linux64", "chrome-headless-shell"),
      join(cache, entry, "chrome-mac", "Chromium.app", "Contents", "MacOS", "Chromium"),
    ]);
}

const SYSTEM = [
  "/usr/bin/chromium",
  "/usr/bin/chromium-browser",
  "/usr/bin/google-chrome",
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
];

export function chromiumPath() {
  const candidates = [process.env.CHROME_PATH, ...fromPlaywrightCache(), ...SYSTEM].filter(Boolean);
  const found = candidates.find((path) => existsSync(path));
  if (found) return found;

  throw new Error(
    "no Chromium found. Install Chromium and set CHROME_PATH to its executable (or run `pnpm exec playwright-core install chromium`).",
  );
}

export function launchChromium(options = {}) {
  return chromium.launch({ executablePath: chromiumPath(), ...options });
}
