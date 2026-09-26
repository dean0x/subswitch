import { createColors } from "picocolors";
import { CodexIngressHealthSchema } from "./codex-health.js";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, isAbsolute, join } from "node:path";
import { parseTOML, getStaticTOMLValue } from "toml-eslint-parser";
import { object } from "./claude-contract.js";
import { CLAUDE_MODELS, claudeResolver, claudeModelRows, isClaudeModelName } from "./claude-models.js";
import { createClaudeCredentialStore, inspectClaudeAuth } from "./claude-auth.js";
import { expandHome, isLoopbackHost, type Config } from "./config.js";
import { doctorRow, makeLiveHttpGet, makeLiveTlsConnect, type HttpGetResult, type TlsStatus } from "./doctor.js";
import { inspectAuthFile } from "./codex-auth.js";

export async function runCodexDoctor(
  config: Config,
  write: (line: string) => void,
  options: {
    env?: Record<string, string | undefined>;
    project?: string;
    color?: boolean;
    read?: (path: string) => Promise<string | null>;
    auth?: () => Promise<{ available: boolean; expired: boolean; refreshable: boolean }>;
    httpGet?: (url: string) => Promise<HttpGetResult>;
    tlsConnect?: (host: string, port: number) => Promise<TlsStatus>;
  } = {},
): Promise<number> {
  const env = options.env ?? process.env;
  const read =
    options.read ??
    (async (path: string) => {
      try {
        return await readFile(path, "utf8");
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
        throw error;
      }
    });
  const pc = createColors(options.color ?? false);
  let failures = 0;
  const report = (label: string, success: boolean, detail: string) => {
    write(doctorRow(`${label}:`, `${success ? pc.green("OK") : pc.red("FAIL")} — ${detail}`));
    if (!success) failures++;
  };
  write("subswitch doctor — Codex → Claude");
  report(
    "routing",
    config.codexIngress.enabled && config.codexIngress.claude.enabled,
    config.codexIngress.claude.enabled ? "Claude model routing enabled" : "run subswitch init --client codex",
  );
  const auth = await (
    options.auth ?? (() => inspectClaudeAuth(createClaudeCredentialStore(config.codexIngress.claude)))
  )().catch(() => ({ available: false, expired: false, refreshable: false }));
  report(
    "Claude subscription",
    auth.available && (!auth.expired || auth.refreshable),
    !auth.available
      ? "sign in with Claude Code or unlock its store"
      : auth.expired
        ? "expired; refresh required"
        : "available",
  );
  const health = await (options.httpGet ?? makeLiveHttpGet())(
    `http://127.0.0.1:${config.port}/__subswitch/health`,
  ).catch(() => ({ ok: false as const, connectionRefused: false }));
  let running = false;
  if (health.ok && health.status === 200) {
    try {
      const parsed = CodexIngressHealthSchema.safeParse(object(JSON.parse(health.body))?.["codexIngress"]);
      running = parsed.success && parsed.data.enabled && parsed.data.translationAvailable;
    } catch {}
  }
  report(
    "proxy",
    running,
    running ? `listening on port ${config.port}` : "start subswitch serve with this configuration",
  );
  const endpoint = new URL(config.codexIngress.claude.baseUrl);
  if (endpoint.protocol === "https:") {
    const tls = await (options.tlsConnect ?? makeLiveTlsConnect())(
      endpoint.hostname,
      Number(endpoint.port || "443"),
    ).catch(() => ({ kind: "unreachable" as const }));
    report("Claude connectivity", tls.kind === "reachable", endpoint.hostname);
  }
  const resolve = claudeResolver(config.codexIngress.claude.aliases);
  for (const row of claudeModelRows(config.codexIngress.claude.aliases)) {
    write(`  model: ${row.id}${row.aliases.length ? ` (${row.aliases.join(", ")})` : ""}`);
    if (!row.registered)
      report(
        "alias target",
        false,
        "custom model capabilities are not in the registry; automatic native discovery is unavailable for this target",
      );
  }
  const globalPath = join(env["CODEX_HOME"] ?? join(homedir(), ".codex"), "config.toml");
  const projectPath = join(options.project ?? process.cwd(), ".codex", "config.toml");
  for (const path of [...new Set([globalPath, projectPath])])
    await checkNativeConfig(path, globalPath, config, read, resolve, report, write);
  write(failures ? pc.red(`${failures} check(s) failed`) : pc.green("all checks passed"));
  return failures ? 1 : 0;
}

const checkNativeConfig = async (
  path: string,
  globalPath: string,
  config: Config,
  read: (path: string) => Promise<string | null>,
  resolve: (model: string) => string | undefined,
  report: (label: string, success: boolean, detail: string) => void,
  write: (line: string) => void,
): Promise<void> => {
  try {
    const source = await read(path);
    if (source === null) {
      if (path === globalPath) report("Codex setup", false, "native configuration is missing; run init --client codex");
      return;
    }
    const root = object(getStaticTOMLValue(parseTOML(source, { tomlVersion: "1.0.0" }))) ?? {};
    if (path === globalPath) {
      let matches = false;
      let subscription = false;
      if (typeof root["openai_base_url"] === "string") {
        try {
          const url = new URL(root["openai_base_url"]);
          matches =
            isLoopbackHost(url.hostname) &&
            url.port === String(config.port) &&
            /^\/codex\/(?:v1|backend-api\/codex)\/?$/.test(url.pathname);
          subscription = url.pathname.includes("/backend-api/codex");
        } catch {}
      }
      report(
        "Codex endpoint",
        matches && (root["model_provider"] === undefined || root["model_provider"] === "openai"),
        matches ? "points at SubSwitch" : "run init --client codex or configure the native endpoint",
      );
      if (matches && subscription) {
        const raw = await read(config.providers.codex.authFile);
        const inspection = raw === null ? undefined : inspectAuthFile(raw);
        report(
          "Codex subscription",
          inspection?.ok === true,
          inspection?.ok
            ? "configured credential store available"
            : "sign in with Codex and select its matching authFile",
        );
      }
    }
    for (const [name, value] of Object.entries(object(root["agents"]) ?? {})) {
      try {
        const role = object(value);
        if (!role) continue;
        let model = role["model"];
        if (typeof role["config_file"] === "string") {
          const file = expandHome(role["config_file"]);
          const source = await read(isAbsolute(file) ? file : join(dirname(path), file));
          if (source === null) {
            report(`agent ${name}`, false, "role configuration file is missing");
            continue;
          }
          model = object(getStaticTOMLValue(parseTOML(source, { tomlVersion: "1.0.0" })))?.["model"];
        }
        if (typeof model !== "string") continue;
        const destination = resolve(model);
        if (destination) write(`  agent ${name}: ${model} → ${destination}`);
        // The same namespace test the gateway uses to refuse a name, so doctor flags exactly what it refuses.
        else if (isClaudeModelName(model) || CLAUDE_MODELS.some((entry) => entry.family === model))
          report(`agent ${name}`, false, "Claude model is not in the registry or configured aliases");
      } catch {
        report(`agent ${name}`, false, "cannot read or parse role configuration");
      }
    }
  } catch {
    report("Codex configuration", false, `cannot parse or read ${path}`);
  }
};
