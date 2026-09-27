/**
 * Fail the build on APIs newer than the minimum supported runtime.
 *
 * The compiler uses ES2024 plus iterator helpers. These three APIs are not
 * available on the oldest supported Node line; this check guards against
 * accidental use of them in the server or scripts.
 *
 * Comments and string literals are stripped first, so mentions in prose
 * do not trip the check. This is a small targeted guard, not a full parser.
 */
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

/** Each entry is an API the type system offers but the runtime floor lacks. */
const UNSUPPORTED = [
  { pattern: /\bRegExp\s*\.\s*escape\b/, name: "RegExp.escape", since: "Node 24" },
  { pattern: /\bError\s*\.\s*isError\b/, name: "Error.isError", since: "Node 24" },
  { pattern: /\bFloat16Array\b/, name: "Float16Array", since: "Node 24" },
];

/** Remove comments and string/template literals so only real code is scanned. */
function stripNonCode(source) {
  return source.replace(
    /\/\*[\s\S]*?\*\/|\/\/[^\n]*|'(?:\\.|[^'\\])*'|"(?:\\.|[^"\\])*"|`(?:\\.|[^`\\])*`/g,
    (match) => " ".repeat(match.length),
  );
}

/**
 * Walk the source directories directly rather than asking git, so the check
 * works on an uncommitted tree; asking git there returns nothing and would
 * report success without having read a single file.
 */
function sourceFiles(dir) {
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return entry.name === "node_modules" ? [] : sourceFiles(path);
    return /\.(ts|tsx|mjs)$/.test(entry.name) ? [path] : [];
  });
}

const files = ["server", "src", "shared", "scripts"].flatMap(sourceFiles);
if (files.length === 0) throw new Error("found no source files to check");

const engines = JSON.parse(readFileSync("package.json", "utf8")).engines?.node ?? "(unset)";
const findings = [];

for (const file of files) {
  const code = stripNonCode(readFileSync(file, "utf8"));
  for (const { pattern, name, since } of UNSUPPORTED) {
    const index = code.search(pattern);
    if (index === -1) continue;
    const line = code.slice(0, index).split("\n").length;
    findings.push(`  ${file}:${line}  ${name} requires ${since}`);
  }
}

if (findings.length > 0) {
  console.error(`\nAPIs newer than the supported runtime (engines.node ${engines}):\n`);
  console.error(findings.join("\n"));
  console.error("\nUse a supported alternative, or raise engines.node and update this check.\n");
  process.exit(1);
}

console.log(`runtime support: ${files.length} files clean for Node ${engines}`);
