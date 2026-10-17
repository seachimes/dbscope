import { launchChromium } from "./browser.mjs";
import { readFileSync, mkdirSync } from "node:fs";
import path from "node:path";
const base = process.env.BASE_URL ?? "http://127.0.0.1:5274";
const sshPort = readFileSync("fixture/.ssh-port", "utf8").trim();
const keyPath = path.resolve("fixture/ssh/id_ed25519");
mkdirSync("shots", { recursive: true });
const browser = await launchChromium();
const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
const assertGeometry = async (label) => {
  const result = await page.evaluate(() => {
    const vw = document.documentElement.clientWidth;
    const offenders = [...document.querySelectorAll("body *")]
      .filter((el) => {
        const s = getComputedStyle(el);
        if (s.position === "fixed" || el instanceof SVGElement) return false;
        const r = el.getBoundingClientRect();
        const scrollParent = el.closest(".tbl-scroll, .graph-wrap");
        return !scrollParent && r.width > 0 && (r.right > vw + 1 || r.left < -1);
      })
      .slice(0, 8)
      .map(
        (el) =>
          `${el.tagName}.${el.className}: ${JSON.stringify(el.getBoundingClientRect().toJSON())}`,
      );
    const clippedSelects = [...document.querySelectorAll(".preference-controls select")]
      .filter((el) => el.scrollWidth > el.clientWidth + 1)
      .map((el) => `${el.value}:${el.clientWidth}/${el.scrollWidth}`);
    return { bodyOverflow: document.documentElement.scrollWidth - vw, offenders, clippedSelects };
  });
  if (result.bodyOverflow > 1 || result.offenders.length || result.clippedSelects.length)
    throw new Error(`${label}: ${JSON.stringify(result)}`);
};
for (const theme of ["light", "dark"]) {
  await page.goto(base);
  await page.evaluate((theme) => {
    localStorage.clear();
    sessionStorage.clear();
    localStorage.setItem("dbscope.locale", "ja");
    localStorage.setItem("dbscope.theme", theme);
  }, theme);
  await page.reload();
  await page.getByRole("button", { name: "接続" }).waitFor();
  await assertGeometry(`connect mobile ${theme}`);
  await page.screenshot({ path: `shots/layout-connect-ja-${theme}-mobile.png`, fullPage: true });
}
await page.setViewportSize({ width: 1280, height: 800 });
await page.fill("#sshHost", "127.0.0.1");
await page.fill("#sshPort", sshPort);
await page.fill("#sshUser", "appuser");
await page.fill("#sshKey", keyPath);
await page.fill("#dbHost", "mysql");
await page.fill("#dbUser", "appuser");
await page.fill("#dbPass", "apppass");
await page.fill("#dbName", "appdb");
await page.getByRole("button", { name: "接続" }).click();
await page.waitForSelector(".graph-svg", { timeout: 45000 });
await assertGeometry("overview desktop");
await page.screenshot({ path: "shots/layout-overview-ja-dark-desktop.png", fullPage: true });
await page.setViewportSize({ width: 390, height: 844 });
await page.waitForTimeout(200);
await assertGeometry("overview mobile");
await page.screenshot({ path: "shots/layout-overview-ja-dark-mobile.png", fullPage: true });
console.log("layout geometry checks passed");
await browser.close();
