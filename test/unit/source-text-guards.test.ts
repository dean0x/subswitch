/**
 * Source-text guards — static assertions about prohibited patterns in src/.
 *
 * These tests are NOT behavioral coverage.  They encode structural obligations
 * that cannot be exercised at runtime while PROVIDER_IDS has only one member.
 * Each guard is clearly labelled so nobody mistakes it for a behavioral test.
 *
 * G1: PROVIDER_IDS[0] must not appear in src/models.ts or src/server.ts.
 *
 *   Background: `collectAliasDeclarations` iterates PROVIDER_IDS and carries
 *   the declaring provider alongside each alias declaration.  Falling back to
 *   PROVIDER_IDS[0] when the declaring provider is already in hand is correct
 *   only by coincidence while PROVIDER_IDS.length === 1.  A runtime test
 *   cannot distinguish the two cases until a second provider is wired, so a
 *   source-text guard is the only preventive control.
 *
 *   Mutation that proves it: insert `PROVIDER_IDS[0]` anywhere in models.ts or
 *   server.ts and this test goes RED.  Remove it and it returns GREEN.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { globSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join, dirname } from "node:path";

const SRC_DIR = join(dirname(fileURLToPath(import.meta.url)), "../../src");

const readSrc = (name: string): string =>
  readFileSync(join(SRC_DIR, name), "utf8");

const KEY_READER = "together-auth.ts";

/**
 * The named uses of the exported key-name constant outside the key reader: one exact
 * trimmed line in one file each. Any other use could compute the key name and read it.
 */
const KEY_NAME_CONSTANT_USES: ReadonlyArray<{ readonly file: string; readonly line: string }> = [
  // run-action drops every letter case of the key name from its copy of the parent env.
  { file: "run-action.ts", line: "if (name.toUpperCase() === TOGETHER_API_KEY_ENV)" },
  // The provider accessor carries the name as data for the credential kind table.
  { file: "config.ts", line: "readonly envName: typeof TOGETHER_API_KEY_ENV;" },
  { file: "config.ts", line: "envName: TOGETHER_API_KEY_ENV," },
];
const IMPORT_FROM_KEY_READER = /^import\s*\{[^}]*\}\s*from\s*["'](?:\.\.?\/)+together-auth\.js["'];$/;

/** An env object reference such as `env`, `process.env` or `deps.env`. */
const ENV_REF = String.raw`(?<![\w$])(?:[\w$]+\s*\??\.\s*)*env\b`;
/** Other ways to select an env entry by a computed name, each with its violation text. */
const ENV_ACCESS_PATTERNS: ReadonlyArray<readonly [RegExp, string]> = [
  // A copy under another name escapes the env index check, which keys on the name `env`.
  [new RegExp(String.raw`\b(?:const|let|var)\s+(?!env\b)[\w$]+\s*(?::[^=;]+)?=\s*(?:\{\s*\.\.\.\s*)?${ENV_REF}(?!\s*(?:\??\.|\[))`),
    "copies an env object under another name"],
  [new RegExp(String.raw`\}\s*=\s*(?:globalThis\s*\.\s*)?process\b(?!\s*\??\.)`), "destructures the process object"],
  [new RegExp(String.raw`\{[^{}]*\[[^\]]*\][^{}]*\}\s*=\s*${ENV_REF}`), "destructures an env object with a computed name"],
  [new RegExp(String.raw`\b(?:Reflect\s*\.\s*(?:get|getOwnPropertyDescriptor|has)|Object\s*\.\s*(?:entries|values|getOwnPropertyDescriptors?))\s*\(\s*${ENV_REF}`),
    "reads an env object through reflection"],
];

/** Return each way a source file could read the Together key outside the key reader. */
const keyAccessViolations = (file: string, source: string): string[] => {
  const violations: string[] = [];
  if (/\bTOGETHER_API_KEY\b/.test(source)) violations.push("names the key env var");
  // An env index must be a quoted name, so a computed name cannot select the key.
  if (/\benv\s*(?:\?\.\s*)?\[\s*(?!["'][\w-]+["']\s*\])/.test(source)) violations.push("indexes an env object with a computed name");
  for (const [pattern, violation] of ENV_ACCESS_PATTERNS) if (pattern.test(source)) violations.push(violation);
  for (const line of source.split("\n").map((text) => text.trim())) {
    if (!line.includes("TOGETHER_API_KEY_ENV") || IMPORT_FROM_KEY_READER.test(line)) continue;
    if (!KEY_NAME_CONSTANT_USES.some((use) => use.file === file && use.line === line)) {
      violations.push(`uses the key name constant: ${line}`);
    }
  }
  return violations;
};

// ---------------------------------------------------------------------------
// G1 — PROVIDER_IDS[0] must not appear in models.ts or server.ts
//
// SOURCE-TEXT GUARD: this assertion checks code structure, not runtime behavior.
// ---------------------------------------------------------------------------

describe("source-text guards", () => {
  it("G1: models and server must not assume the first entry in PROVIDER_IDS is the intended provider", () => {
    const modelsTs = readSrc("models.ts");
    const serverTs = readSrc("server.ts");

    // The forbidden pattern as a literal — searching for the exact characters
    // so the guard cannot be fooled by whitespace or reformatting.
    const forbidden = "PROVIDER_IDS[0]";

    assert.ok(
      !modelsTs.includes(forbidden),
      `src/models.ts contains "${forbidden}" — the declaring provider must always be in hand (see KNOWLEDGE.md anti-patterns); PROVIDER_IDS[0] is valid only by coincidence while PROVIDER_IDS.length === 1`,
    );
    assert.ok(
      !serverTs.includes(forbidden),
      `src/server.ts contains "${forbidden}" — the declaring provider must always be in hand (see KNOWLEDGE.md anti-patterns); PROVIDER_IDS[0] is valid only by coincidence while PROVIDER_IDS.length === 1`,
    );
  });

  it("keeps direct Together key env access in the key reader, including for health", () => {
    const files = globSync("**/*.{ts,mts,cts,js,mjs,cjs}", { cwd: SRC_DIR });
    assert.ok(files.includes(KEY_READER), "The source list must include the Together key reader");
    for (const file of files) {
      if (file === KEY_READER) continue;
      assert.deepEqual(keyAccessViolations(file, readSrc(file)), [], `Use the Together key reader for env access in src/${file}`);
    }
  });

  it("catches a computed Together key name and allows only the named uses of the name constant", () => {
    const computed = [
      ["a name held in a variable", "const name = TOGETHER_API_KEY_ENV;\nconst raw = process.env[name];"],
      ["a name built from parts", 'const name = ["TOGETHER", "API", "KEY"].join("_");\nconst raw = process.env[name];'],
      ["a name in a template", "const raw = env[`TOGETHER_${part}`];"],
      ["the constant as a computed key", "const raw = deps.env[TOGETHER_API_KEY_ENV];"],
      ["the constant through Reflect", "const raw = Reflect.get(process.env, TOGETHER_API_KEY_ENV);"],
      ["the run-action key name check in another file", "if (name.toUpperCase() === TOGETHER_API_KEY_ENV)"],
      ["an env object alias", "const vars = process.env;\nconst raw = vars[name];"],
      ["a typed env object alias", "const vars: NodeJS.ProcessEnv = deps.env;\nconst raw = vars[name];"],
      ["a spread copy of the env object", "const vars = { ...process.env };\nconst raw = vars[name];"],
      ["a renamed env from the process object", "const { env: vars } = process;\nconst raw = vars[name];"],
      ["computed destructuring", "const { [name]: raw } = process.env;"],
      ["a computed name through Reflect", "const raw = Reflect.get(process.env, name);"],
      ["iteration over the env object", "const raw = Object.entries(deps.env).find(([key]) => key.endsWith(suffix));"],
    ] as const;
    for (const [label, source] of computed) {
      assert.notDeepEqual(keyAccessViolations("server.ts", source), [], `The guard must catch ${label}`);
    }
    const runAction = [
      'import { TOGETHER_API_KEY_ENV } from "./together-auth.js";',
      "  const env = { ...parent };",
      "  for (const name of Object.keys(env)) {",
      "    if (name.toUpperCase() === TOGETHER_API_KEY_ENV)",
      "      Reflect.deleteProperty(env, name);",
      "  }",
      "    const env = childEnvWithoutTogetherKey(process.env);",
      '    const home = process.env["HOME"] ?? process.env.HOME;',
      '    env["ANTHROPIC_BASE_URL"] = base;',
    ].join("\n");
    assert.deepEqual(keyAccessViolations("run-action.ts", runAction), []);
  });

  it("requires the fake marker on every Together key fixture", () => {
    const path = join(SRC_DIR, "../test/fixtures/together/keys.json");
    const fixtures: unknown = JSON.parse(readFileSync(path, "utf8"));
    assert.ok(typeof fixtures === "object" && fixtures !== null && !Array.isArray(fixtures));
    const values: unknown[] = Object.values(fixtures);
    assert.ok(values.length > 0);
    for (const value of values) {
      assert.ok(typeof value === "string" && value.startsWith("FAKE-TOGETHER-KEY-"), "Use marked Together key fixtures");
    }
  });
});

it("uses execFile with no shell for the Together Keychain read", () => {
  const reader = readSrc("together-auth.ts");
  const factory = readSrc("server.ts");
  assert.match(factory, /exec: promisify\(execFile\)/);
  for (const source of [reader, factory]) {
    assert.doesNotMatch(source, /import\s*\{[^}]*\bexec\b[^}]*\}\s*from\s*["']node:child_process["']/);
    assert.doesNotMatch(source, /\bshell\s*:/);
  }
});
