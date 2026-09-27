import { strict as assert } from "node:assert";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

/**
 * Guards the compiler settings themselves.
 *
 * TypeScript silently ignores an unrecognised `lib` entry — `ES2025` is not a
 * valid name in 5.9 — and the result is not an error but a config that quietly
 * stops applying. These tests assert the settings are real and still match the
 * runtime the project claims to support.
 */
const root = new URL("..", import.meta.url);
const tsconfig = JSON.parse(
  readFileSync(new URL("tsconfig.json", root), "utf8").replace(/^\s*\/\/.*$/gm, ""),
);
const pkg = JSON.parse(readFileSync(new URL("package.json", root), "utf8"));

test("every configured lib is one the compiler recognises", () => {
  // tsc lists the valid names when given a bad one, which is the only
  // authoritative source for the installed version.
  let accepted: string[] = [];
  try {
    execFileSync("npx", ["tsc", "--lib", "__invalid__", "--noEmit"], {
      cwd: fileURLToPath(root),
      stdio: "pipe",
    });
  } catch (err) {
    const output =
      String((err as { stdout?: Buffer; stderr?: Buffer }).stdout ?? "") +
      String((err as { stderr?: Buffer }).stderr ?? "");
    accepted = [...output.matchAll(/'([a-z0-9.]+)'/g)].map((m) => m[1]!);
  }

  assert.ok(accepted.length > 0, "could not determine the accepted lib names");
  for (const lib of tsconfig.compilerOptions.lib as string[]) {
    assert.ok(
      accepted.includes(lib.toLowerCase()),
      `lib "${lib}" is not recognised by this TypeScript and is being silently ignored`,
    );
  }
});

test("the target matches the runtime the package claims to support", () => {
  // Node 22 implements ES2024 in full. Raising the target past that would let
  // syntax through that the oldest supported runtime line cannot parse.
  assert.equal(tsconfig.compilerOptions.target, "ES2024");
  assert.match(pkg.engines.node, /^\^22\.\d+\.\d+ \|\|/);
});

test("the strictness settings that catch real bugs stay enabled", () => {
  for (const flag of [
    "strict",
    "noUncheckedIndexedAccess",
    "exactOptionalPropertyTypes",
    "noImplicitOverride",
    "noFallthroughCasesInSwitch",
    "noImplicitReturns",
    "noUnusedLocals",
    "noUnusedParameters",
  ]) {
    assert.equal(tsconfig.compilerOptions[flag], true, `${flag} must stay on`);
  }
});

test("type-only syntax stays erasable for the server", () => {
  // The server runs through Node's type stripping, with no TypeScript-aware
  // loader, so anything that needs real emit would break `pnpm start`.
  assert.equal(tsconfig.compilerOptions.verbatimModuleSyntax, true);
  assert.equal(tsconfig.compilerOptions.isolatedModules, true);
});
