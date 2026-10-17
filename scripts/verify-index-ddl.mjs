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

    await page.goto(`${base}/tables/posts`);
    const suggestion = page.locator(".issue-fix", { has: page.locator(".issue-ddl") }).first();
    const suggested = (await suggestion.locator(".issue-ddl").textContent()) ?? "";
    check(
      `issue suggestions use ${engine} syntax`,
      engine === "mysql"
        ? suggested.startsWith("ALTER TABLE")
        : suggested.startsWith("CREATE INDEX"),
      suggested,
    );
    await suggestion.locator(".ddl-copy").click();
    await suggestion.locator(".ddl-copy", { hasText: "Copied" }).waitFor();
    check(
      "copy puts the issue suggestion on the clipboard",
      (await page.evaluate(() => navigator.clipboard.readText())) === suggested,
    );

    await page.goto(`${base}/tables/${table}`);
    await page.getByRole("tab", { name: "Indexes" }).click();
    for (const column of columns) {
      await page.locator(".col-chip", { hasText: new RegExp(`^${column}`) }).click();
    }

    const preview = (await page.locator(".ddl-block pre").first().textContent()) ?? "";
    check(
      `preview uses ${engine} syntax`,
      engine === "mysql" ? preview.startsWith("ALTER TABLE") : preview.startsWith("CREATE INDEX"),
      preview,
    );

    await page.locator(".ddl-block .ddl-copy").first().click();
    await page.locator(".ddl-copy", { hasText: "Copied" }).first().waitFor();
    check(
      "copy puts the preview on the clipboard",
      (await page.evaluate(() => navigator.clipboard.readText())) === preview,
    );

    await page.getByRole("button", { name: "Create index" }).click();
    const executedBlock = page.locator(".field", { hasText: "Executed DDL" }).locator("pre");
    await executedBlock.waitFor({ timeout: 60000 });
    const executed = (await executedBlock.textContent()) ?? "";
    check("the executed DDL is shown after creation", executed.length > 0);
    check(
      "the preview matches the executed DDL",
      preview === executed,
      `${preview} != ${executed}`,
    );

    const created = engine === "mysql" ? "idx_name_id" : "idx_categories_name_id";
    const row = page.locator(".tbl tr", { hasText: created });
    await row.getByRole("button", { name: "Drop" }).click();
    await page
      .locator(".field", { hasText: "Executed DDL" })
      .locator("pre", { hasText: "DROP INDEX" })
      .waitFor({ timeout: 60000 });
    check("dropping shows the executed DROP INDEX", true);
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
