/** The session id lives per tab: a reload keeps it, a new tab or a closed tab does not. */
import { launchChromium } from "./browser.mjs";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const root = fileURLToPath(new URL("..", import.meta.url));
const sshPort = readFileSync(path.join(root, "fixture/.ssh-port"), "utf8").trim();
const base = process.env.BASE_URL ?? "http://127.0.0.1:5274";

const browser = await launchChromium();
const context = await browser.newContext();
let failures = 0;
const check = (label, ok, detail = "") => {
  if (!ok) failures++;
  console.log(`  ${ok ? "✓" : "✗"} ${label}${ok || !detail ? "" : ` (${detail})`}`);
};
const stored = (page) =>
  page.evaluate(() => ({
    session: sessionStorage.getItem("dbscope.session"),
    local: localStorage.getItem("dbscope.session"),
  }));

try {
  const page = await context.newPage();
  await page.goto(base);
  await page.evaluate(() => localStorage.setItem("dbscope.session", "stale-id-from-old-build"));
  await page.reload();
  check(
    "a session id left in localStorage is removed on load",
    (await stored(page)).local === null,
  );

  await page.fill("#sshHost", "127.0.0.1");
  await page.fill("#sshPort", sshPort);
  await page.fill("#sshUser", "appuser");
  await page.fill("#sshKey", path.join(root, "fixture/ssh/id_ed25519"));
  await page.fill("#dbHost", "mysql");
  await page.fill("#dbUser", "appuser");
  await page.fill("#dbPass", "apppass");
  await page.fill("#dbName", "appdb");
  await page.click("button[type=submit]");
  await page.waitForSelector(".graph-svg", { timeout: 45000 });

  const afterConnect = await stored(page);
  check("connect stores the id in sessionStorage", Boolean(afterConnect.session));
  check("connect leaves localStorage without an id", afterConnect.local === null);
  check(
    "connection settings are still remembered in localStorage",
    await page.evaluate(() => localStorage.getItem("dbscope.connect.form") !== null),
  );

  await page.reload();
  await page.waitForSelector(".graph-svg", { timeout: 45000 });
  check("a reload keeps the connection", (await stored(page)).session === afterConnect.session);

  const other = await context.newPage();
  await other.goto(base);
  await other.waitForSelector(".connect-title");
  check("a new tab starts at the connect form", (await stored(other)).session === null);
} finally {
  await browser.close();
}

if (failures) {
  console.log(`\n${failures} session storage check(s) failed`);
  process.exit(1);
}
console.log("\nsession storage checks passed");
