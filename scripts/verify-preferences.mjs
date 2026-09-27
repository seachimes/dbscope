import { launchChromium } from "./browser.mjs";
import { mkdirSync } from "node:fs";
mkdirSync("shots", { recursive: true });
const browser = await launchChromium();
const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
await page.goto(process.env.BASE_URL ?? "http://127.0.0.1:5274");
await page.evaluate(() => {
  localStorage.removeItem("dbscope.session");
  localStorage.setItem("dbscope.locale", "ja");
  localStorage.setItem("dbscope.theme", "light");
});
await page.reload();
await page.getByRole("heading", { name: "DBSCOPE" }).waitFor();
if ((await page.locator("html").getAttribute("data-theme")) !== "light")
  throw new Error("light theme not applied");
if ((await page.locator("html").getAttribute("lang")) !== "ja")
  throw new Error("Japanese lang not applied");
await page.getByRole("button", { name: "接続" }).waitFor();
await page.screenshot({ path: "shots/08-ja-light-connect.png", fullPage: true });
await page.getByLabel("言語").selectOption("en");
await page.getByRole("button", { name: "Connect" }).waitFor();
await page.getByLabel("Theme").selectOption("dark");
if ((await page.locator("html").getAttribute("data-theme")) !== "dark")
  throw new Error("dark switch not applied");
console.log("Japanese/light and English/dark preference checks passed");
await browser.close();
