/**
 * Drive the real UI in a real browser against the real fixture.
 *
 * This walks the primary investigation path: connect over SSH, look at the
 * Overview, open the hottest table, explain a query, apply the suggested index,
 * and read the verdict. Screenshots are written for visual review.
 */
import { launchChromium } from "./browser.mjs";
import { readFileSync, mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const root = fileURLToPath(new URL("..", import.meta.url));
const shots = path.join(root, "shots");
mkdirSync(shots, { recursive: true });

const sshPort = readFileSync(path.join(root, "fixture/.ssh-port"), "utf8").trim();
const keyPath = path.join(root, "fixture/ssh/id_ed25519");
const base = process.env.BASE_URL ?? "http://127.0.0.1:5274";

const browser = await launchChromium();
const page = await browser.newPage({ viewport: { width: 1480, height: 950 } });

const problems = [];
page.on("console", (m) => {
  if (m.type() === "error") problems.push(`console: ${m.text()}`);
});
page.on("pageerror", (e) => problems.push(`pageerror: ${e.message}`));

const step = async (name, fn) => {
  process.stdout.write(`  ${name} … `);
  try {
    await fn();
    console.log("ok");
  } catch (err) {
    console.log("FAILED");
    problems.push(`${name}: ${err.message}`);
    await page.screenshot({ path: path.join(shots, `FAIL-${name}.png`) }).catch(() => {});
  }
};

console.log("verifying UI against the fixture");

await step("load", async () => {
  await page.goto(base, { waitUntil: "networkidle" });
  // Start from a clean slate so the connect form is always exercised.
  await page.evaluate(() => (localStorage.clear(), sessionStorage.clear()));
  await page.reload({ waitUntil: "networkidle" });
  await page.waitForSelector(".connect-title");
  await page.screenshot({ path: path.join(shots, "01-connect.png") });
});

await step("connect", async () => {
  await page.fill("#sshHost", "127.0.0.1");
  await page.fill("#sshPort", sshPort);
  await page.fill("#sshUser", "appuser");
  await page.fill("#sshKey", keyPath);
  await page.fill("#dbHost", "mysql");
  await page.fill("#dbUser", "appuser");
  await page.fill("#dbPass", "apppass");
  await page.fill("#dbName", "appdb");
  await page.click("button[type=submit]");
  await page.waitForSelector(".graph-svg", { timeout: 45000 });
});

await step("overview", async () => {
  await page.waitForSelector(".node-g", { timeout: 20000 });
  const nodes = await page.locator(".node-g").count();
  if (nodes < 5) throw new Error(`expected 6 table nodes, found ${nodes}`);
  const unindexed = await page.locator(".edge-unindexed").count();
  if (unindexed === 0) throw new Error("unindexed joins were not drawn");
  await page.screenshot({ path: path.join(shots, "02-overview.png"), fullPage: true });
});

await step("table-detail", async () => {
  await page.locator(".node-g").first().click();
  await page.waitForSelector(".tabs", { timeout: 20000 });
  await page.waitForSelector(".tbl tbody tr", { timeout: 20000 });
  await page.screenshot({ path: path.join(shots, "03-table-data.png"), fullPage: true });

  await page.getByRole("tab", { name: "Schema" }).click();
  await page.waitForSelector("pre.raw");
  await page.getByRole("tab", { name: "Indexes" }).click();
  await page.waitForSelector(".col-pick");
  await page.screenshot({ path: path.join(shots, "04-indexes.png"), fullPage: true });
});

await step("queries", async () => {
  await page.keyboard.press("2");
  await page.waitForSelector(".qrow", { timeout: 25000 });
  const rows = await page.locator(".qrow").count();
  if (rows === 0) throw new Error("no queries listed");
  await page.locator(".qrow").first().click();
  await page.screenshot({ path: path.join(shots, "05-queries.png"), fullPage: true });
});

await step("explain", async () => {
  await page.keyboard.press("3");
  await page.waitForSelector(".sql-editor", { timeout: 15000 });
  await page.fill(
    ".sql-editor",
    "SELECT id, user_id, body FROM posts WHERE user_id = 42 ORDER BY created_at DESC LIMIT 20",
  );
  await page.locator(".btn-primary", { hasText: "Explain" }).click();
  await page.waitForSelector(".flow-step", { timeout: 30000 });

  const text = await page.locator(".flow").innerText();
  if (!/FULL SCAN/.test(text)) throw new Error("full scan not shown in the plan flow");
  if (!/FILESORT/.test(text)) throw new Error("filesort not shown in the plan flow");
  await page.screenshot({ path: path.join(shots, "06-explain.png"), fullPage: true });
});

await step("apply-and-compare", async () => {
  const button = page.getByRole("button", { name: "Create and compare" }).first();
  await button.waitFor({ timeout: 15000 });
  await button.click();
  await page.waitForSelector(".verdict", { timeout: 90000 });

  const verdict = await page.locator(".verdict").innerText();
  if (!/fewer rows/.test(verdict))
    throw new Error(`verdict did not show an improvement: ${verdict.slice(0, 120)}`);
  console.log(`\n    ${verdict.split("\n").slice(0, 3).join(" | ")}`);
  await page.screenshot({ path: path.join(shots, "07-before-after.png"), fullPage: true });
});

await step("cleanup-index", async () => {
  // Leave the fixture as we found it so the script is re-runnable. Only the
  // index this run created is dropped, and only if it is actually there.
  const res = await page.evaluate(async () => {
    const id = sessionStorage.getItem("dbscope.session");
    const headers = { "x-dbscope-session": id ?? "" };
    const indexes = await (await fetch("/api/tables/posts/indexes", { headers })).json();
    const mine = indexes.find((i) => i.name === "idx_user_id_created_at");
    if (!mine) return "absent";
    const r = await fetch("/api/indexes/posts/idx_user_id_created_at", {
      method: "DELETE",
      headers,
    });
    return r.status;
  });
  if (res !== 200 && res !== "absent") throw new Error(`drop index returned ${res}`);
});

await browser.close();

console.log("");
if (problems.length > 0) {
  console.log(`${problems.length} problem(s):`);
  for (const p of problems) console.log("  -", p);
  process.exit(1);
}
console.log("all UI checks passed; screenshots in shots/");
