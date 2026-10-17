/** The index DDL shown before and after creation is the statement the server runs, and it copies. */
import { launchChromium } from "./browser.mjs";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const root = fileURLToPath(new URL("..", import.meta.url));
const sshPort = readFileSync(path.join(root, "fixture/.ssh-port"), "utf8").trim();
const base = process.env.BASE_URL ?? "http://127.0.0.1:5274";
const table = "categories";
const columns = ["name", "id"];

const browser = await launchChromium();
let failures = 0;
const check = (label, ok, detail = "") => {
  if (!ok) failures++;
  console.log(`  ${ok ? "✓" : "✗"} ${label}${ok || !detail ? "" : ` (${detail})`}`);
};

async function connect(page, engine) {
  await page.goto(base);
  await page.evaluate(() => (localStorage.clear(), sessionStorage.clear()));
  await page.reload();
  await page.selectOption(".engine-select", engine);
  await page.fill("#sshHost", "127.0.0.1");
  await page.fill("#sshPort", sshPort);
  await page.fill("#sshUser", "appuser");
  await page.fill("#sshKey", path.join(root, "fixture/ssh/id_ed25519"));
  await page.fill("#dbHost", engine);
  await page.fill("#dbPort", engine === "mysql" ? "3306" : "5432");
  await page.fill("#dbUser", "appuser");
  await page.fill("#dbPass", "apppass");
  await page.fill("#dbName", "appdb");
  await page.click("button[type=submit]");
  await page.waitForSelector(".graph-svg", { timeout: 60000 });
}

try {
  for (const engine of ["mysql", "postgres"]) {
    console.log(`\n${engine}`);
    const context = await browser.newContext({
      permissions: ["clipboard-read", "clipboard-write"],
    });
    const page = await context.newPage();
    page.on("dialog", (dialog) => dialog.accept());
    await connect(page, engine);

    const text = async (locator) => ((await locator.textContent()) ?? "").trim();
    const copies = async (box) => {
      const shown = await text(box.locator("pre"));
      await box.locator(".ddl-copy").click();
      await box.locator('.ddl-copy[data-state="copied"]').waitFor();
      return (await page.evaluate(() => navigator.clipboard.readText())) === shown;
    };
    const runSyntax = engine === "mysql" ? "ALTER TABLE" : "CREATE INDEX CONCURRENTLY";

    await page.goto(`${base}/tables/posts`);
    const issue = page.locator(".issue .ddl-block").first();
    const issueRun = await text(issue.locator('pre[data-kind="run"]'));
    const issueFile = await text(issue.locator('pre[data-kind="file"]'));
    check(`issue suggestions run ${engine} syntax`, issueRun.startsWith(runSyntax), issueRun);
    check(
      "issue suggestions offer a plain CREATE INDEX for SQL files",
      /^CREATE INDEX \S+ ON \S+ \(/.test(issueFile) && !issueFile.includes("CONCURRENTLY"),
      issueFile,
    );
    check(
      "copy puts the file form on the clipboard",
      await copies(issue.locator(".ddl-box", { has: page.locator('pre[data-kind="file"]') })),
    );

    await page.goto(`${base}/tables/${table}`);
    await page.getByRole("tab", { name: "Indexes" }).click();
    for (const column of columns) {
      await page.locator(".col-chip", { hasText: new RegExp(`^${column}`) }).click();
    }
    const preview = page.locator(".ddl-block").first();
    const previewRun = await text(preview.locator('pre[data-kind="run"]'));
    const previewFile = await text(preview.locator('pre[data-kind="file"]'));
    check(`preview runs ${engine} syntax`, previewRun.startsWith(runSyntax), previewRun);
    check(
      "copy puts the run form on the clipboard",
      await copies(preview.locator(".ddl-box", { has: page.locator('pre[data-kind="run"]') })),
    );

    await page.getByRole("button", { name: "Create index" }).click();
    const executed = page.locator(".field", { hasText: "Executed DDL" });
    await executed.locator('pre[data-kind="run"]').waitFor({ timeout: 60000 });
    const executedRun = await text(executed.locator('pre[data-kind="run"]'));
    const executedFile = await text(executed.locator('pre[data-kind="file"]'));
    check(
      "the preview matches the executed DDL",
      previewRun === executedRun,
      `${previewRun} != ${executedRun}`,
    );
    check(
      "the preview file form matches the server's",
      previewFile === executedFile,
      `${previewFile} != ${executedFile}`,
    );

    const created = engine === "mysql" ? "idx_name_id" : "idx_categories_name_id";
    await page
      .locator(".tbl tr", { hasText: created })
      .getByRole("button", { name: "Drop" })
      .click();
    await executed
      .locator('pre[data-kind="file"]', { hasText: "DROP INDEX" })
      .waitFor({ timeout: 60000 });
    check(
      "dropping shows a plain DROP INDEX for SQL files",
      !(await text(executed.locator('pre[data-kind="file"]'))).includes("CONCURRENTLY"),
    );
    await context.close();
  }
} finally {
  await browser.close();
}

if (failures) {
  console.log(`\n${failures} index DDL check(s) failed`);
  process.exit(1);
}
console.log("\nindex DDL checks passed");
