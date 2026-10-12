import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ProfileAuth } from "../../src/routing/profile-auth.js";
import type { AccessProfile } from "../../src/routing/routing-types.js";
import {
  CodexAuthManager,
  createFsAuthFileStore,
} from "../../src/codex-auth.js";
import {
  ClaudeAuthManager,
  createClaudeCredentialStore,
} from "../../src/claude-auth.js";
import { providerEvents } from "../../src/provider-events.js";
import { coordinateNativeRefresh } from "../../src/native-auth-coordination.js";
import { loadConfig } from "../../src/config.js";
import { validateExplicitConfig } from "../../src/routing/routing-config.js";
import type { RoutePolicy } from "../../src/routing/routing-types.js";

const logger = { log() {} };
const signal = () => new AbortController().signal;
const gate = () => {
  let open!: () => void;
  const wait = new Promise<void>((resolve) => {
    open = resolve;
  });
  return { wait, open };
};
const nextTick = () => new Promise<void>((resolve) => setImmediate(resolve));
const token = (account?: string, version = "first") =>
  `e30.${Buffer.from(
    JSON.stringify({
      exp: Date.now() / 1000 + 3600,
      ...(account
        ? { "https://api.openai.com/auth": { chatgpt_account_id: account } }
        : {}),
    }),
  ).toString("base64url")}.${version}`;

async function withNativeProfile(
  run: (
    auth: ProfileAuth,
    save: (account?: string, explicit?: boolean) => Promise<void>,
    path: string,
  ) => Promise<void>,
): Promise<void> {
  const directory = await mkdtemp(join(tmpdir(), "subswitch-auth-review-"));
  const path = join(directory, "auth.json");
  const profile: AccessProfile = {
    provider: "codex",
    product: "chatgpt-codex",
    billing: "subscription",
    account: "synthetic-slot",
    credential: { kind: "native-oauth", authFile: path },
  };
  const save = (account?: string, explicit = false) =>
    writeFile(
      path,
      JSON.stringify({
        tokens: {
          access_token: token(account),
          refresh_token: "synthetic-refresh",
          ...(explicit ? { account_id: account } : {}),
        },
        last_refresh: new Date().toISOString(),
      }),
      { mode: 0o600 },
    );
  try {
    await run(new ProfileAuth({ native: profile }, logger), save, path);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

describe("reviewed native profile ownership", () => {
  for (const explicit of [false, true]) {
    it(`reloads a JWT-owned account replacement after ${explicit ? "an explicit" : "a JWT-only"} account`, async () => {
      await withNativeProfile(async (auth, save) => {
        await save("synthetic-account-one", explicit);
        const first = await auth.get("native", signal());
        const firstScope = auth.scope(first);
        await save("synthetic-account-two");
        const second = await auth.get("native", signal());
        assert.equal(
          second.authHeaders["chatgpt-account-id"],
          "synthetic-account-two",
        );
        assert.notEqual(first.generation, second.generation);
        assert.notDeepEqual(firstScope, auth.scope(second));
        assert.throws(
          () => auth.validate(first),
          /credential_binding_mismatch/,
        );
      });
    });
  }

  it("rejects identity disappearance and invalidates cached credentials", async () => {
    await withNativeProfile(async (auth, save) => {
      await save("synthetic-account-one");
      const first = await auth.get("native", signal());
      await save();
      await assert.rejects(
        auth.get("native", signal()),
        /profile_auth_unavailable/,
      );
      assert.throws(() => auth.validate(first), /credential_binding_mismatch/);
    });
  });

  it("rejects a removed auth file and invalidates cached credentials", async () => {
    await withNativeProfile(async (auth, save, path) => {
      await save("synthetic-account-one");
      const first = await auth.get("native", signal());
      await rm(path);
      await assert.rejects(
        auth.get("native", signal()),
        /profile_auth_unavailable/,
      );
      assert.throws(() => auth.validate(first), /credential_binding_mismatch/);
    });
  });

  it("preserves JWT-owned identity through an ordinary OAuth refresh", async () => {
    await withNativeProfile(async (auth, save) => {
      await save("synthetic-account-one");
      const first = await auth.get("native", signal());
      const firstScope = auth.scope(first);
      const originalFetch = globalThis.fetch;
      let calls = 0;
      globalThis.fetch = async (url) => {
        assert.equal(String(url), "https://auth.openai.com/oauth/token");
        calls++;
        return Response.json({
          access_token: token("synthetic-account-one", "refreshed"),
          refresh_token: "synthetic-refresh-rotated",
          token_type: "Bearer",
          expires_in: 3600,
        });
      };
      try {
        const refreshed = await auth.refresh("native", signal());
        assert.equal(calls, 1);
        assert.notEqual(
          first.authHeaders.authorization,
          refreshed.authHeaders.authorization,
        );
        assert.equal(first.generation, refreshed.generation);
        assert.deepEqual(firstScope, auth.scope(refreshed));
        auth.validate(first);
        const reread = await auth.get("native", signal());
        assert.equal(reread.generation, first.generation);
        assert.equal(
          reread.authHeaders.authorization,
          refreshed.authHeaders.authorization,
        );
      } finally {
        globalThis.fetch = originalFetch;
      }
    });
  });
});

describe("native credential store refresh coordination", () => {
  it("coordinates Codex aliases and the legacy parent, surviving one cancelled waiter", async () => {
    await withNativeProfile(async (auth, save, path) => {
      await save("synthetic-account-one");
      const profile: AccessProfile = {
        provider: "codex",
        product: "chatgpt-codex",
        billing: "subscription",
        account: "synthetic-slot",
        credential: { kind: "native-oauth", authFile: path },
      };
      const errors: string[] = [];
      const observedLogger = {
        log(_level: string, event: string) {
          errors.push(event);
        },
      };
      const aliases = new ProfileAuth(
        { one: profile, two: { ...profile } },
        observedLogger,
      );
      const legacy = new CodexAuthManager({
        store: createFsAuthFileStore(path),
        oauthTokenUrl: "https://auth.openai.com/oauth/token",
        logger: observedLogger,
        events: providerEvents("codex"),
        fetchImpl: (url, init) => globalThis.fetch(url, init),
      });
      const [first, one, two] = await Promise.all([
        auth.get("native", signal()),
        aliases.get("one", signal()),
        aliases.get("two", signal()),
      ]);
      assert.equal((await legacy.getCredentials()).ok, true);
      const originalFetch = globalThis.fetch,
        started = gate(),
        release = gate();
      let calls = 0,
        refreshSignal: AbortSignal | undefined;
      globalThis.fetch = async (_url, init) => {
        calls++;
        refreshSignal = init?.signal ?? undefined;
        started.open();
        await release.wait;
        return Response.json({
          access_token: token("synthetic-account-one", "coordinated"),
          refresh_token: "synthetic-rotated",
          token_type: "Bearer",
          expires_in: 3600,
        });
      };
      try {
        const cancelled = new AbortController();
        const abortedWaiter = auth.refresh("native", cancelled.signal);
        // Attach the rejection handler before cancellation to avoid an unhandled promise.
        const rejected = assert.rejects(abortedWaiter, { name: "AbortError" });
        const remaining = Promise.all([
          legacy.forceRefresh(),
          aliases.refresh("one", signal()),
          aliases.refresh("two", signal()),
        ]);
        await started.wait;
        await nextTick();
        await nextTick();
        cancelled.abort();
        await rejected;
        assert.equal(refreshSignal?.aborted, false);
        release.open();
        const [native, refreshedOne, refreshedTwo] = await remaining;
        assert.equal(native.ok, true);
        assert.equal(calls, 1);
        assert.equal(refreshedOne.generation, one.generation);
        assert.equal(refreshedTwo.generation, two.generation);
        const reread = await auth.get("native", signal());
        assert.equal(reread.generation, first.generation);
        assert.equal(
          reread.authHeaders.authorization,
          refreshedOne.authHeaders.authorization,
        );
        assert.equal(errors.includes("codex_auth_file_write_failed"), false);
        assert.equal(
          (await readdir(join(path, ".."))).some((name) =>
            name.endsWith(".tmp"),
          ),
          false,
        );
      } finally {
        release.open();
        globalThis.fetch = originalFetch;
      }
    });
  });

  it("invalidates every same-file Codex alias when one detects account replacement", async () => {
    await withNativeProfile(async (_auth, save, path) => {
      const profile: AccessProfile = {
        provider: "codex",
        product: "chatgpt-codex",
        billing: "subscription",
        account: "synthetic-slot",
        credential: { kind: "native-oauth", authFile: path },
      };
      const aliases = new ProfileAuth(
        { one: profile, two: { ...profile } },
        logger,
      );
      await save("synthetic-account-one");
      const first = await aliases.get("one", signal()),
        second = await aliases.get("two", signal());
      await save("synthetic-account-two");
      const replaced = await aliases.get("one", signal());
      assert.throws(
        () => aliases.validate(first),
        /credential_binding_mismatch/,
      );
      assert.throws(
        () => aliases.validate(second),
        /credential_binding_mismatch/,
      );
      assert.notEqual(first.generation, replaced.generation);
      assert.equal(
        (await aliases.get("two", signal())).authHeaders["chatgpt-account-id"],
        "synthetic-account-two",
      );
    });
  });

  it("coordinates Claude legacy and explicit aliases while preserving refresh lineage", async () => {
    const directory = await mkdtemp(
      join(tmpdir(), "subswitch-claude-auth-review-"),
    );
    const path = join(directory, "credentials.json");
    const originalFetch = globalThis.fetch,
      started = gate(),
      release = gate();
    try {
      await writeFile(
        path,
        JSON.stringify({
          claudeAiOauth: {
            accessToken: "synthetic-first",
            refreshToken: "synthetic-refresh",
            expiresAt: Date.now() + 3600000,
          },
        }),
        { mode: 0o600 },
      );
      const profile: AccessProfile = {
        provider: "claude",
        product: "claude-code",
        billing: "subscription",
        account: "synthetic-slot",
        credential: { kind: "native-oauth", authFile: path },
      };
      const auth = new ProfileAuth(
        { one: profile, two: { ...profile } },
        logger,
      );
      const legacy = new ClaudeAuthManager({
        store: createClaudeCredentialStore({ authFile: path }),
        oauthTokenUrl: "https://platform.claude.com/v1/oauth/token",
        logger,
        fetchImpl: (url, init) => globalThis.fetch(url, init),
      });
      const [one, two] = await Promise.all([
        auth.get("one", signal()),
        auth.get("two", signal()),
      ]);
      assert.equal((await legacy.getCredentials()).ok, true);
      let calls = 0;
      globalThis.fetch = async () => {
        calls++;
        started.open();
        await release.wait;
        return Response.json({
          access_token: "synthetic-refreshed",
          refresh_token: "synthetic-rotated",
          expires_in: 3600,
        });
      };
      // Start legacy first so its store performs the write without the profile wrapper.
      const native = legacy.forceRefresh();
      await started.wait;
      const joined = Promise.all([
        auth.refresh("one", signal()),
        auth.refresh("two", signal()),
      ]);
      await nextTick();
      await nextTick();
      release.open();
      const [refreshedOne, refreshedTwo] = await joined;
      assert.equal((await native).ok, true);
      assert.equal(calls, 1);
      assert.equal(refreshedOne.generation, one.generation);
      assert.equal(refreshedTwo.generation, two.generation);
      assert.equal(
        (await auth.get("one", signal())).generation,
        one.generation,
      );
      assert.equal(
        (await auth.get("two", signal())).generation,
        two.generation,
      );
      assert.equal(
        refreshedOne.authHeaders.authorization,
        "Bearer synthetic-refreshed",
      );
      assert.equal(
        (await readdir(directory)).some((name) => name.endsWith(".tmp")),
        false,
      );
      // An external replacement is not covered by the shared refresh's proof.
      await writeFile(
        path,
        JSON.stringify({
          claudeAiOauth: {
            accessToken: "synthetic-another-owner",
            expiresAt: Date.now() + 3600000,
          },
        }),
      );
      const replacement = await auth.get("one", signal());
      assert.notEqual(replacement.generation, one.generation);
      assert.throws(
        () => auth.validate(refreshedTwo),
        /credential_binding_mismatch/,
      );
      const replacedScope = auth.scope(replacement);
      const secondReplacement = await auth.get("two", signal());
      assert.deepEqual(auth.scope(secondReplacement), replacedScope);
      assert.deepEqual(auth.scope(replacement), replacedScope);
    } finally {
      release.open();
      globalThis.fetch = originalFetch;
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("queues different owners and endpoints, while isolating other providers and stores", async () => {
    const storage = `synthetic-store-${Date.now()}`,
      release = gate();
    let secondCalls = 0;
    const first = coordinateNativeRefresh(
      "codex",
      storage,
      "endpoint-a:owner-a",
      async () => {
        await release.wait;
        return "first-owner";
      },
    );
    const second = coordinateNativeRefresh(
      "codex",
      storage,
      "endpoint-b:owner-b",
      async () => {
        secondCalls++;
        return "second-owner";
      },
    );
    const sameSecond = coordinateNativeRefresh(
      "codex",
      storage,
      "endpoint-b:owner-b",
      async () => {
        throw new Error("same owner should share the queued operation");
      },
    );
    assert.equal(
      await coordinateNativeRefresh(
        "codex",
        `${storage}-other`,
        "endpoint-a:owner-a",
        async () => "other-store",
      ),
      "other-store",
    );
    assert.equal(
      await coordinateNativeRefresh(
        "claude",
        storage,
        "endpoint-a:owner-a",
        async () => "other-provider",
      ),
      "other-provider",
    );
    assert.equal(secondCalls, 0);
    release.open();
    assert.deepEqual(await Promise.all([first, second, sameSecond]), [
      "first-owner",
      "second-owner",
      "second-owner",
    ]);
    assert.equal(secondCalls, 1);
  });

  it("rejects a Claude credential when another alias observes a replacement before binding", async (t) => {
    const directory = await mkdtemp(
      join(tmpdir(), "subswitch-claude-owner-race-"),
    );
    const path = join(directory, "credentials.json");
    const originalFetch = globalThis.fetch,
      resolved = gate(),
      release = gate();
    const save = (accessToken: string) =>
      writeFile(
        path,
        JSON.stringify({
          claudeAiOauth: {
            accessToken,
            refreshToken: "synthetic-refresh",
            expiresAt: Date.now() + 3600000,
          },
        }),
        { mode: 0o600 },
      );
    try {
      await save("synthetic-first-owner");
      const profile: AccessProfile = {
        provider: "claude",
        product: "claude-code",
        billing: "subscription",
        account: "synthetic-slot",
        credential: { kind: "native-oauth", authFile: path },
      };
      const auth = new ProfileAuth(
        { one: profile, two: { ...profile } },
        logger,
      );
      const first = await auth.get("one", signal());
      const forceRefresh = ClaudeAuthManager.prototype.forceRefresh;
      // Park at the asynchronous native-auth return boundary, then replace the store
      // through another real profile read before the parked result can be bound.
      t.mock.method(
        ClaudeAuthManager.prototype,
        "forceRefresh",
        async function (this: ClaudeAuthManager) {
          const result = await forceRefresh.call(this);
          resolved.open();
          await release.wait;
          return result;
        },
      );
      globalThis.fetch = async () =>
        Response.json({
          access_token: "synthetic-first-owner-refreshed",
          expires_in: 3600,
        });
      const pending = auth.refresh("one", signal());
      const rejected = assert.rejects(pending, /credential_owner_changed/);
      await resolved.wait;
      await save("synthetic-second-owner");
      const replacement = await auth.get("two", signal());
      assert.notEqual(replacement.generation, first.generation);
      release.open();
      await rejected;
      assert.throws(() => auth.validate(first), /credential_binding_mismatch/);
    } finally {
      release.open();
      globalThis.fetch = originalFetch;
      await rm(directory, { recursive: true, force: true });
    }
  });
});

describe("native file store aliases", () => {
  for (const provider of ["codex", "claude"] as const) {
    for (const aliasKind of [
      "file",
      "directory",
      "new-directory-file",
    ] as const) {
      it(`${provider} preserves ${aliasKind} symlinks and shares the physical persistence target`, async () => {
        const directory = await mkdtemp(
          join(tmpdir(), "subswitch-auth-symlink-review-"),
        );
        const physicalDirectory = join(directory, "physical");
        const physicalPath = join(physicalDirectory, "credentials.json");
        try {
          await mkdir(physicalDirectory);
          if (aliasKind !== "new-directory-file")
            await writeFile(physicalPath, "synthetic-original", {
              mode: 0o600,
            });
          const link = join(directory, "alias");
          const alias =
            aliasKind === "file" ? link : join(link, "credentials.json");
          // Relative links exercise the same behavior as absolute configured auth paths.
          await symlink(
            aliasKind === "file" ? "physical/credentials.json" : "physical",
            link,
          );
          const createStore = (path: string) => {
            if (provider === "codex") {
              const store = createFsAuthFileStore(path);
              return {
                coordinationKey: store.coordinationKey,
                write: async (raw: string) =>
                  assert.equal((await store.writeAtomic(raw)).ok, true),
                read: async () => {
                  const value = await store.read();
                  assert.equal(value.ok, true);
                  if (!value.ok) throw new Error("synthetic store read failed");
                  return value.value;
                },
              };
            }
            return createClaudeCredentialStore({ authFile: path });
          };
          const throughAlias = createStore(alias),
            direct = createStore(physicalPath);
          assert.equal(throughAlias.coordinationKey, direct.coordinationKey);
          await throughAlias.write("synthetic-refreshed");
          assert.equal(
            await readFile(physicalPath, "utf8"),
            "synthetic-refreshed",
          );
          assert.equal(await direct.read(), "synthetic-refreshed");
          assert.equal((await lstat(link)).isSymbolicLink(), true);
          await direct.write("synthetic-followup");
          assert.equal(await throughAlias.read(), "synthetic-followup");
          assert.equal((await lstat(physicalPath)).mode & 0o777, 0o600);
          assert.equal(
            (await readdir(physicalDirectory)).some((name) =>
              name.endsWith(".tmp"),
            ),
            false,
          );
        } finally {
          await rm(directory, { recursive: true, force: true });
        }
      });
    }
  }
});

describe("own configuration declaration lookup", () => {
  const profile: AccessProfile = {
    provider: "kimi",
    product: "kimi-platform",
    region: "global",
    billing: "api",
    account: "synthetic-platform",
    credential: { kind: "env", name: "SYNTHETIC_KEY" },
  };
  const policy = (id: string, model = "kimi-k3"): RoutePolicy => ({
    clients: ["codex"],
    primary: { profile: id, model, effort: "high" },
    fallbacks: [],
    transientTriggers: [],
    affinity: "native-or-explicit",
  });
  const load = (raw: object) =>
    loadConfig({
      configPath: "/synthetic/config.json",
      env: {},
      readFile: () => JSON.stringify(raw),
    });

  it("rejects inherited profile targets at startup and reports closed auth errors", async () => {
    const auth = new ProfileAuth({}, logger);
    for (const label of [
      "constructor",
      "toString",
      "hasOwnProperty",
      "valueOf",
    ]) {
      assert.deepEqual(
        validateExplicitConfig({}, { work: policy(label) }, () => false),
        ["work: unknown_profile"],
      );
      const loaded = load({
        configVersion: 2,
        routes: { work: policy(label) },
      });
      assert.equal(loaded.ok, false);
      if (!loaded.ok) assert.match(loaded.error.message, /unknown_profile/);
      assert.equal(auth.has(label), false);
      await assert.rejects(auth.get(label, signal()), /unknown_profile/);
      assert.throws(
        () => auth.refresh(label, signal()),
        /profile_not_refreshable/,
      );
    }
    const inherited = Object.create({ hidden: profile }) as Record<
      string,
      AccessProfile
    >;
    assert.deepEqual(
      validateExplicitConfig(
        inherited,
        { work: policy("hidden") },
        () => false,
      ),
      ["work: unknown_profile"],
    );
    const hidden = new ProfileAuth(inherited, logger, {
      SYNTHETIC_KEY: "synthetic-key",
    });
    assert.equal(hidden.has("hidden"), false);
    await assert.rejects(hidden.get("hidden", signal()), /unknown_profile/);
  });

  it("permits explicitly declared prototype-like profile and route labels", async () => {
    const loaded = load({
      configVersion: 2,
      accessProfiles: { constructor: profile },
      routes: { toString: policy("constructor") },
    });
    if (!loaded.ok) throw new Error(loaded.error.message);
    const auth = new ProfileAuth(loaded.value.config.accessProfiles!, logger, {
      SYNTHETIC_KEY: "synthetic-key",
    });
    assert.equal(auth.has("constructor"), true);
    const credential = await auth.get("constructor", signal());
    assert.equal(credential.profile, "constructor");
    assert.equal(credential.authHeaders.authorization, "Bearer synthetic-key");
    auth.validate(credential);
  });

  it("resolves declared constructor aliases, without interpreting inherited aliases as chains", () => {
    const api: AccessProfile = {
      provider: "codex",
      product: "openai-api",
      billing: "api",
      account: "synthetic-api",
      credential: { kind: "env", name: "SYNTHETIC_KEY" },
    };
    const loaded = load({
      configVersion: 2,
      accessProfiles: { api },
      routes: { work: policy("api", "constructor") },
      providers: { codex: { aliases: { constructor: "gpt-6-sol" } } },
    });
    if (!loaded.ok) throw new Error(loaded.error.message);
    assert.equal(loaded.value.config.routes?.work?.primary.model, "gpt-6-sol");
    const invalid = load({
      configVersion: 2,
      accessProfiles: { api },
      routes: { work: policy("api", "first") },
      providers: { codex: { aliases: { first: "constructor" } } },
    });
    assert.equal(invalid.ok, false);
    if (!invalid.ok) {
      assert.match(invalid.error.message, /invalid_target_model/);
      assert.doesNotMatch(invalid.error.message, /alias chains/);
    }
  });

  it("does not resolve a declared key from inherited environment values", async () => {
    const inheritedEnv = Object.create({
      SYNTHETIC_KEY: "synthetic-hidden-key",
    }) as NodeJS.ProcessEnv;
    const auth = new ProfileAuth({ platform: profile }, logger, inheritedEnv);
    assert.equal(auth.has("platform"), false);
    await assert.rejects(
      auth.get("platform", signal()),
      /profile_credentials_missing/,
    );
  });
});
