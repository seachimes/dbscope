/**
 * Drive the real UI in a real browser against the PostgreSQL fixture.
 *
 * Walks the primary investigation path — connect, table detail, indexes,
 * EXPLAIN, and the improvement loop — and drops the index it creates so the
 * run is repeatable.
 */
import { launchChromium } from "./browser.mjs";
import { mkdirSync, readFileSync } from "node:fs";
import path from "node:path";

const base = process.env.BASE_URL ?? "http://127.0.0.1:5274";
const sshPort = readFileSync("fixture/.ssh-port", "utf8").trim();
// Paste the key body rather than a path: a multi-line key must survive the form
// intact. (verify-ui.mjs covers the path form on MySQL.)
const keyText = readFileSync(path.resolve("fixture/ssh/id_ed25519"), "utf8");

mkdirSync("shots", { recursive: true });
const browser = await launchChromium();
const page = await browser.newPage({ viewport: { width: 1400, height: 1000 } });

const pageErrors = [];
page.on("pageerror", (err) => pageErrors.push(String(err)));
// Any dialog here is a deliberate confirmation for a schema change.
page.on("dialog", (dialog) => dialog.accept());

const step = (name) => process.stdout.write(`  ${name} … `);
const ok = () => console.log("ok");

console.log("verifying the PostgreSQL UI against the fixture");

try {
  step("connect");
  await page.goto(base);
  await page.evaluate(() => (localStorage.clear(), sessionStorage.clear()));
  await page.reload();
  await page.selectOption(".engine-select", "postgres");
  await page.fill("#sshHost", "127.0.0.1");
  await page.fill("#sshPort", sshPort);
  await page.fill("#sshUser", "appuser");
  await page.fill("#sshKey", keyText);
  await page.fill("#dbHost", "postgres");
  await page.fill("#dbPort", "5432");
  await page.fill("#dbUser", "appuser");
  await page.fill("#dbPass", "apppass");
  await page.fill("#dbName", "appdb");
  await page.click("button[type=submit]");
  await page.waitForSelector(".graph-svg", { timeout: 60_000 });
  const sidebar = await page.locator(".rail-section").last().textContent();
  if (!sidebar.includes("postgres")) throw new Error("the session does not report PostgreSQL");
  ok();

  step("table-detail");
  // reactions is the fixture's healthy counterexample: it is the one table with
  // an index on post_id, so it exercises reading real index columns.
  await page.goto(`${base}/tables/reactions`);
  await page.waitForSelector(".tabs");
  await page.getByRole("tab", { name: /Indexes|インデックス/ }).click();
  await page.waitForSelector(".tbl");
  const indexRows = await page.locator(".tbl tbody tr").allInnerTexts();
  // Regression guard: an unparsed name[] used to crash this tab outright.
  if (!indexRows.some((row) => row.includes("post_id"))) {
    throw new Error(`index columns missing: ${JSON.stringify(indexRows)}`);
  }
  ok();

  step("explain");
  await page.goto(`${base}/explain`);
  await page.waitForSelector(".sql-editor");
  await page.fill(
    ".sql-editor",
    "SELECT id FROM posts WHERE user_id = 42 ORDER BY created_at DESC LIMIT 20",
  );
  await page.getByRole("button", { name: /Explain|実行計画/ }).click();
  await page.waitForSelector(".flow-step");
  const plan = await page.locator(".flow-step").allInnerTexts();
  if (!plan.some((s) => s.includes("SEQ SCAN"))) {
    throw new Error(`expected a sequential scan, got ${JSON.stringify(plan)}`);
  }
  // Rows *read*, not rows emitted. The scan touches the whole table, so the
  // step must report the table's size rather than the ~130 rows it returns.
  const scanned = plan.find((s) => s.includes("SEQ SCAN")) ?? "";
  const reported = Number(/([\d,]{4,})\s*Rows/.exec(scanned)?.[1]?.replace(/,/g, "") ?? 0);
  if (reported < 200_000) {
    throw new Error(`the full scan under-reports its rows read: ${scanned}`);
  }
  ok();

  step("apply-and-compare");
  const compare = page.getByRole("button", { name: /Create and compare|作成して比較/ });
  if ((await compare.count()) === 0) throw new Error("no index suggestion was offered");
  await compare.first().click();
  await page.waitForSelector(".verdict", { timeout: 120_000 });
  const verdict = (await page.locator(".verdict").first().innerText()).replace(/\n+/g, " ");
  if (/No change|変化なし/.test(verdict))
    throw new Error(`verdict reported no improvement: ${verdict}`);
  console.log(`\n    ${verdict.slice(0, 120)}`);
  await page.screenshot({ path: "shots/pg-improvement-loop.png" });
  ok();

  step("cleanup-index");
  // Leaving the index behind would make the next run find no sequential scan.
  const created = /CREATE INDEX CONCURRENTLY "([^"]+)"/.exec(verdict)?.[1];
  if (!created) throw new Error(`could not read the created index name from: ${verdict}`);
  await page.goto(`${base}/tables/posts`);
  await page.waitForSelector(".tabs");
  await page.getByRole("tab", { name: /Indexes|インデックス/ }).click();
  await page.waitForSelector(".tbl");
  await page.locator("tr", { hasText: created }).getByRole("button", { name: /Drop/ }).click();
  await page.waitForFunction(
    (name) => !document.querySelector(".tbl")?.textContent?.includes(name),
    created,
    { timeout: 60_000 },
  );
  ok();

  if (pageErrors.length > 0) throw new Error(`page errors: ${pageErrors.join(" | ")}`);
  console.log("\nall PostgreSQL UI checks passed; screenshots in shots/");
} finally {
  await browser.close();
}
