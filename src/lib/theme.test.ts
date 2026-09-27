import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { contrastRatio, meetsBodyText, meetsNonText, relativeLuminance } from "./contrast.ts";

/**
 * Contrast is checked against the stylesheets themselves rather than a copy of
 * the palette, so a token edited in CSS cannot silently drift past the limits.
 */
function tokens(file: string, selector: RegExp): Record<string, string> {
  const css = readFileSync(fileURLToPath(new URL(`../${file}`, import.meta.url)), "utf8");
  const match = selector.exec(css);
  assert.notEqual(match, null, `${selector} matched nothing in ${file}`);

  const start = match!.index;
  const block = css.slice(start, css.indexOf("}", start));

  const found: Record<string, string> = {};
  for (const [, name, value] of block.matchAll(/--([\w-]+):\s*(#[0-9a-fA-F]{3,8})\s*;/g)) {
    found[name!] = value!;
  }
  return found;
}

// Selectors are matched by pattern rather than exact text: the formatter is
// free to normalise quoting and whitespace, and a test that breaks on that is
// testing the formatter rather than the theme.
const dark = tokens("styles.css", /^:root\s*\{/m);
const light = tokens("theme-light.css", /^:root\[data-theme=["']light["']\]\s*\{/m);

const SURFACES = ["ink", "panel", "panel-2"] as const;
const TEXTS = ["text", "text-dim", "text-faint"] as const;
const SEMANTIC = ["t0", "t1", "t2", "t3", "t4"] as const;

for (const [name, theme] of [
  ["dark", dark],
  ["light", light],
] as const) {
  test(`${name}: every text tone is readable on every surface`, () => {
    for (const surface of SURFACES) {
      for (const tone of TEXTS) {
        const ratio = contrastRatio(theme[tone]!, theme[surface]!);
        assert.ok(
          meetsBodyText(ratio),
          `--${tone} on --${surface} is ${ratio.toFixed(2)}:1, below the 4.5:1 required for body text`,
        );
      }
    }
  });

  test(`${name}: severity colors are readable, including the critical end`, () => {
    for (const tone of SEMANTIC) {
      const ratio = contrastRatio(theme[tone]!, theme.panel!);
      assert.ok(
        meetsBodyText(ratio),
        `--${tone} on --panel is ${ratio.toFixed(2)}:1; a severity color that cannot be read is worse than none`,
      );
    }
  });

  test(`${name}: borders that carry meaning meet the non-text requirement`, () => {
    for (const surface of ["ink", "panel"] as const) {
      const ratio = contrastRatio(theme["line-strong"]!, theme[surface]!);
      assert.ok(
        meetsNonText(ratio),
        `--line-strong on --${surface} is ${ratio.toFixed(2)}:1, below the 3:1 of WCAG 1.4.11`,
      );
    }
  });

  test(`${name}: the focus ring is clearly visible`, () => {
    const ratio = contrastRatio(theme.t0!, theme.panel!);
    assert.ok(meetsNonText(ratio), `focus ring is ${ratio.toFixed(2)}:1 on --panel`);
  });
}

test("dark: peak contrast stays below the level that causes halation", () => {
  // Pure white on near-black measures about 19:1 and is what makes a dark UI
  // tiring to read. Anything from 7:1 (AAA) up to ~16:1 stays comfortable.
  const peak = contrastRatio(dark.text!, dark.ink!);
  assert.ok(peak >= 7, `peak contrast ${peak.toFixed(2)}:1 is below AAA`);
  assert.ok(peak < 16, `peak contrast ${peak.toFixed(2)}:1 is high enough to cause glare`);
});

test("dark: the background is lifted off pure black", () => {
  // Compared by luminance rather than contrast ratio: between two very dark
  // colors the ratio barely moves, so it is the wrong instrument here.
  const [ink, panel, panel2] = [dark.ink!, dark.panel!, dark["panel-2"]!].map(relativeLuminance);
  assert.ok(ink! > 0.005, `--ink is essentially pure black (luminance ${ink!.toFixed(4)})`);
  // Surfaces must still read as distinct layers.
  assert.ok(panel! > ink! && panel2! > panel!, "surfaces do not get progressively lighter");
});

test("light: text is dark on light, not the reverse", () => {
  assert.ok(
    contrastRatio(light.text!, "#ffffff") > contrastRatio(light.text!, "#000000"),
    "the light theme text token looks like a dark-theme value",
  );
});
