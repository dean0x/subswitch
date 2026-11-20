/**
 * Source-text guards — static assertions about prohibited patterns in src/.
 *
 * These tests are NOT behavioral coverage.  They encode structural obligations
 * that cannot be exercised at runtime while PROVIDER_IDS has only one member.
 * Each guard is clearly labelled so nobody mistakes it for a behavioral test.
 *
 * G1: no file in src/ reads PROVIDER_IDS at index 0.
 *
 *   Background: `collectAliasDeclarations` iterates PROVIDER_IDS and carries
 *   the declaring provider alongside each alias declaration.  Code that takes
 *   PROVIDER_IDS[0] as "the provider" is correct only for the provider that is
 *   first (codex; routing-table.test.ts keeps it first), so the mistake shows
 *   only on a request for another provider.  This guard checks every source file.
 *
 *   Mutation that proves it: insert `PROVIDER_IDS[0]` in any file under src/
 *   and this test goes RED.  Remove it and it returns GREEN.
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
// G1 — no source file reads PROVIDER_IDS at index 0
//
// SOURCE-TEXT GUARD: this assertion checks code structure, not runtime behavior.
// ---------------------------------------------------------------------------

/**
 * `PROVIDER_IDS[0]`, `PROVIDER_IDS.at(0)` and the cast form `(PROVIDER_IDS as T)[0]`.
 * Whitespace is allowed at each joint, so a reformat can not hide a match.
 */
const FIRST_PROVIDER_ID_READ = /\bPROVIDER_IDS(?:\s+as\s+[^)]*\))?\s*(?:\[\s*0\s*\]|\.\s*at\s*\(\s*0\s*\))/;

describe("source-text guards", () => {
  it("G1: no source file assumes the first entry in PROVIDER_IDS is the intended provider", () => {
    const files = globSync("**/*.{ts,mts,cts,js,mjs,cjs}", { cwd: SRC_DIR });
    assert.ok(files.includes("models.ts") && files.includes("server.ts"), "The source list must include models.ts and server.ts");
    for (const file of files) {
      assert.ok(
        !FIRST_PROVIDER_ID_READ.test(readSrc(file)),
        `src/${file} reads PROVIDER_IDS at index 0 — the declaring provider must always be in hand (see KNOWLEDGE.md anti-patterns)`,
      );
    }
  });

  it("G1: the first-entry pattern catches each form of the read", () => {
    for (const read of ["PROVIDER_IDS[0]", "PROVIDER_IDS [ 0 ]", "PROVIDER_IDS.at(0)", "(PROVIDER_IDS as readonly string[])[0]"]) {
      assert.ok(FIRST_PROVIDER_ID_READ.test(`const id = ${read};`), `the pattern must catch ${read}`);
    }
    assert.ok(!FIRST_PROVIDER_ID_READ.test("for (const id of PROVIDER_IDS) {}"), "a loop over the ids is not a first-entry read");
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

// ---------------------------------------------------------------------------
// G2 — only server.ts defines live deps factories
//
// SOURCE-TEXT GUARD: a live factory builds the real readers, stores and runners. Only
// server.ts defines one, so a test that injects fakes can not meet a second, unseen copy.
// cli.ts and run-action.ts may call one. A runner needs node:child_process, so only the
// named files may load that module.
// ---------------------------------------------------------------------------

const LIVE_FACTORY_HOME = "server.ts";
const LIVE_FACTORY_CALLERS: ReadonlySet<string> = new Set(["cli.ts", "run-action.ts"]);
/** A live factory name: live<Thing>Deps. */
const LIVE_FACTORY_NAME = /\blive[A-Z][\w$]*Deps\b/;
/** A declaration, a rename by `as`, an assignment, a property key or a method of that name. */
const LIVE_FACTORY_DEFINITION =
  /(?:\b(?:function\s*\*?|const|let|var|class)\s+|\bas\s+)live[A-Z][\w$]*Deps\b|\blive[A-Z][\w$]*Deps\s*(?:[:=](?!=)|\([^)]*\)\s*(?::[^{;]*)?\{)/;
/** The files that may load node:child_process, each with its reason. */
const CHILD_PROCESS_FILES: ReadonlyMap<string, string> = new Map([
  ["server.ts", "the live deps factories build the program runners"],
  ["claude-auth.ts", "the Claude client-ingress store runs the macOS Keychain tool"],
  ["run-action.ts", "run-action starts the client command that the user names"],
]);
const CHILD_PROCESS_MODULE = /["'](?:node:)?child_process["']/;

const liveFactoryViolations = (file: string, source: string): string[] => {
  if (file === LIVE_FACTORY_HOME) return [];
  const violations: string[] = [];
  if (CHILD_PROCESS_MODULE.test(source) && !CHILD_PROCESS_FILES.has(file)) violations.push("loads node:child_process");
  for (const line of source.split("\n").map((text) => text.trim())) {
    if (!LIVE_FACTORY_NAME.test(line)) continue;
    if (LIVE_FACTORY_DEFINITION.test(line)) violations.push(`defines a live factory: ${line}`);
    else if (!LIVE_FACTORY_CALLERS.has(file)) violations.push(`uses a live factory: ${line}`);
  }
  return violations;
};

// ---------------------------------------------------------------------------
// G3 — every CLI child in test/ starts through the shared CLI-child helper
//
// SOURCE-TEXT GUARD: the helper gives the child a fresh HOME, XDG_CONFIG_HOME,
// XDG_CACHE_HOME and SUBSWITCH_CONFIG, and the exec-deny preload. A test that names the
// CLI entry file itself could start a child that reads the user's real stores.
// ---------------------------------------------------------------------------

const TEST_DIR = join(SRC_DIR, "../test");
const CLI_CHILD_HELPER = "helpers/cli-child.ts";
/**
 * A path to the source or the built CLI entry file: the folder (src or dist) and the file
 * name on one line. A bare file name, as in the G2 file lists, is data and not a path.
 */
const CLI_ENTRY_FILE = /\bsrc\b[^\n]*\bcli\.ts\b|\bdist\b[^\n]*\bcli\.js\b/;

describe("source-text guards: CLI child processes", () => {
  it("G3: only the CLI-child helper names the CLI entry file in test/", () => {
    const files = globSync("**/*.{ts,mts,cts,js,mjs,cjs}", { cwd: TEST_DIR });
    assert.ok(files.includes(CLI_CHILD_HELPER) && files.includes("integration/cli.test.ts"),
      "The test file list must include the helper and the CLI tests");
    assert.match(readFileSync(join(TEST_DIR, CLI_CHILD_HELPER), "utf8"), CLI_ENTRY_FILE);
    for (const file of files) {
      if (file === CLI_CHILD_HELPER) continue;
      assert.doesNotMatch(readFileSync(join(TEST_DIR, file), "utf8"), CLI_ENTRY_FILE,
        `Start the CLI child in test/${file} through test/${CLI_CHILD_HELPER}`);
    }
  });

  it("G3: the entry pattern catches each way to name the CLI entry file", () => {
    // Built from parts, so this file does not name the entry file itself.
    const entry = "cli" + ".ts", built = "cli" + ".js";
    for (const text of [`join(repoRoot, "src", "${entry}")`, `resolve("src/${entry}")`, `new URL("../../src/${entry}", import.meta.url)`,
      `join(root, "dist", "${built}")`]) {
      assert.match(text, CLI_ENTRY_FILE, `The pattern must catch ${text}`);
    }
    for (const text of ['import { cliChildCommand } from "../helpers/cli-child.js";', `new Set(["${entry}", "run-action.ts"])`]) {
      assert.doesNotMatch(text, CLI_ENTRY_FILE, `The pattern must allow ${text}`);
    }
  });
});

describe("source-text guards: live deps factories", () => {
  it("G2: only server.ts defines a live factory, and only cli.ts and run-action.ts call one", () => {
    const files = globSync("**/*.{ts,mts,cts,js,mjs,cjs}", { cwd: SRC_DIR });
    for (const file of [LIVE_FACTORY_HOME, ...LIVE_FACTORY_CALLERS, ...CHILD_PROCESS_FILES.keys()]) {
      assert.ok(files.includes(file), `The source list must include ${file}`);
    }
    assert.match(readSrc(LIVE_FACTORY_HOME), /export const liveTogetherKeyReaderDeps = /);
    for (const file of files) {
      assert.deepEqual(liveFactoryViolations(file, readSrc(file)), [], `Move the live factory to src/${LIVE_FACTORY_HOME}`);
    }
  });

  it("G2: the guard catches each way to define a live factory or a runner outside server.ts", () => {
    const definitions = [
      "export const liveKimiStoreDeps = () => ({",
      "function liveGeminiDeps() {",
      "export function* liveFooDeps() {",
      "let liveFooDeps;",
      "export { build as liveFooDeps };",
      "const deps = { liveFooDeps: () => ({}) };",
      "liveFooDeps(): FooDeps {",
      "liveFooDeps = () => ({});",
    ];
    for (const line of definitions) {
      assert.notDeepEqual(liveFactoryViolations("cli.ts", line), [], `The guard must catch: ${line}`);
    }
    const runners = ['import { spawn } from "node:child_process";', "const { execFile } = await import('child_process');"];
    for (const line of runners) assert.notDeepEqual(liveFactoryViolations("gemini-renewal.ts", line), [], `The guard must catch: ${line}`);
    assert.notDeepEqual(liveFactoryViolations("doctor.ts", "togetherKeyReader: liveTogetherKeyReaderDeps(),"), [],
      "a file that is not a named caller must not call a live factory");
    const calls = [
      'import { liveTogetherKeyReaderDeps, buildDeps, createProxyServer, listenServer } from "./server.js";',
      "togetherKeyReader: liveTogetherKeyReaderDeps(),",
      "const deps = cond === liveFooDeps() ? a : b;",
    ];
    for (const line of calls) assert.deepEqual(liveFactoryViolations("cli.ts", line), [], `A named caller may call: ${line}`);
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
