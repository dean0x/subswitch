import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { decideRoute } from "../../src/router.js";
import {
  buildRoutingTable,
  MODEL_REGISTRY,
  resolveModel,
  type ModelResolution,
  type ProviderId,
} from "../../src/models.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const { table } = buildRoutingTable(MODEL_REGISTRY, { codex: {} });

const resolve = (name: string): ModelResolution => resolveModel(table, name);

// ---------------------------------------------------------------------------
// F1: Exact id routing
// ---------------------------------------------------------------------------

describe("decideRoute — exact id (F1)", () => {
  it("routes gpt-5.5 on /v1/messages", () => {
    const result = decideRoute("POST", "/v1/messages", resolve("gpt-5.5"));
    assert.deepEqual(result, { kind: "provider", provider: "codex" as ProviderId, model: "gpt-5.5", endpoint: "messages" });
  });

  it("routes gpt-5.6-terra on /v1/messages", () => {
    const result = decideRoute("POST", "/v1/messages", resolve("gpt-5.6-terra"));
    assert.deepEqual(result, { kind: "provider", provider: "codex" as ProviderId, model: "gpt-5.6-terra", endpoint: "messages" });
  });

  it("routes gpt-5.6-sol on /v1/messages with query string", () => {
    const result = decideRoute("POST", "/v1/messages?beta=true", resolve("gpt-5.6-sol"));
    assert.deepEqual(result, { kind: "provider", provider: "codex" as ProviderId, model: "gpt-5.6-sol", endpoint: "messages" });
  });
});

// ---------------------------------------------------------------------------
// F2: Family alias routing
// ---------------------------------------------------------------------------

describe("decideRoute — family alias (F2)", () => {
  it("routes 'sol' (family alias → gpt-5.6-sol) to provider", () => {
    const result = decideRoute("POST", "/v1/messages", resolve("sol"));
    assert.deepEqual(result, { kind: "provider", provider: "codex" as ProviderId, model: "gpt-5.6-sol", endpoint: "messages" });
  });

  it("routes 'terra' (family alias → gpt-5.6-terra) to provider", () => {
    const result = decideRoute("POST", "/v1/messages", resolve("terra"));
    assert.deepEqual(result, { kind: "provider", provider: "codex" as ProviderId, model: "gpt-5.6-terra", endpoint: "messages" });
  });

  it("routes 'luna' (family alias → gpt-5.6-luna) to provider", () => {
    const result = decideRoute("POST", "/v1/messages", resolve("luna"));
    assert.deepEqual(result, { kind: "provider", provider: "codex" as ProviderId, model: "gpt-5.6-luna", endpoint: "messages" });
  });
});

// ---------------------------------------------------------------------------
// F8: Anthropic reserved words always reach Anthropic
// ---------------------------------------------------------------------------

describe("decideRoute — Anthropic reserved words (F8)", () => {
  it("claude-* models route to anthropic", () => {
    const result = decideRoute("POST", "/v1/messages?beta=true", resolve("claude-sonnet-4-6"));
    assert.deepEqual(result, { kind: "anthropic" });
  });

  it("'sonnet' tier word routes to anthropic", () => {
    assert.deepEqual(decideRoute("POST", "/v1/messages", resolve("sonnet")), { kind: "anthropic" });
  });

  it("'opus' tier word routes to anthropic", () => {
    assert.deepEqual(decideRoute("POST", "/v1/messages", resolve("opus")), { kind: "anthropic" });
  });

  it("'haiku' tier word routes to anthropic", () => {
    assert.deepEqual(decideRoute("POST", "/v1/messages", resolve("haiku")), { kind: "anthropic" });
  });

  it("'inherit' sentinel routes to anthropic", () => {
    assert.deepEqual(decideRoute("POST", "/v1/messages", resolve("inherit")), { kind: "anthropic" });
  });
});

// ---------------------------------------------------------------------------
// count_tokens endpoint routing
// ---------------------------------------------------------------------------

describe("decideRoute — count_tokens endpoint", () => {
  it("routes gpt-5.5 on /v1/messages/count_tokens to endpoint=count_tokens", () => {
    const result = decideRoute("POST", "/v1/messages/count_tokens", resolve("gpt-5.5"));
    assert.deepEqual(result, { kind: "provider", provider: "codex" as ProviderId, model: "gpt-5.5", endpoint: "count_tokens" });
  });
});

// ---------------------------------------------------------------------------
// Method and path fallthrough
// ---------------------------------------------------------------------------

describe("decideRoute — non-POST / non-messages paths", () => {
  it("GET /v1/messages routes to anthropic", () => {
    assert.deepEqual(decideRoute("GET", "/v1/messages", resolve("gpt-5.5")), { kind: "anthropic" });
  });

  it("POST /v1/complete routes to anthropic", () => {
    assert.deepEqual(decideRoute("POST", "/v1/complete", resolve("gpt-5.5")), { kind: "anthropic" });
  });

  it("undefined model (unresolved) routes to anthropic", () => {
    assert.deepEqual(decideRoute("POST", "/v1/messages", { kind: "unresolved" }), { kind: "anthropic" });
  });
});

// ---------------------------------------------------------------------------
// F13: decideRoute never sees a bare alias — resolveModel is the only name-matcher
// ---------------------------------------------------------------------------

describe("decideRoute — receives ModelResolution, not raw names (F13)", () => {
  it("'sol' after resolution routes to gpt-5.6-sol, not anthropic", () => {
    // If decideRoute tried to match names itself, it would fail on "sol" (unrecognized).
    // The fact that it routes correctly proves resolution happened before routing.
    const result = decideRoute("POST", "/v1/messages", resolve("sol"));
    assert.equal(result.kind, "provider");
    if (result.kind === "provider") {
      assert.equal(result.model, "gpt-5.6-sol");
    }
  });
});

// ---------------------------------------------------------------------------
// F7: Ambiguous family → ambiguous route
// ---------------------------------------------------------------------------

describe("decideRoute — ambiguous family (F7)", () => {
  it("returns ambiguous route when resolution is ambiguous", () => {
    const resolution: ModelResolution = {
      kind: "ambiguous",
      name: "fast",
      providers: ["codex" as ProviderId, "kimi" as unknown as ProviderId],
    };
    const result = decideRoute("POST", "/v1/messages", resolution);
    assert.equal(result.kind, "ambiguous");
    if (result.kind === "ambiguous") {
      assert.equal(result.name, "fast");
      assert.deepEqual([...result.providers], ["codex", "kimi"]);
    }
  });

  it("ambiguous route not returned for non-POST or non-messages paths", () => {
    const resolution: ModelResolution = {
      kind: "ambiguous",
      name: "fast",
      providers: ["codex" as ProviderId],
    };
    assert.deepEqual(decideRoute("GET", "/v1/messages", resolution), { kind: "anthropic" });
    assert.deepEqual(decideRoute("POST", "/v1/complete", resolution), { kind: "anthropic" });
  });
});

// ---------------------------------------------------------------------------
// Unknown provider qualifier
// ---------------------------------------------------------------------------

describe("decideRoute — unknown_provider qualifier", () => {
  it("returns unknown_provider route when resolution is unknown_qualifier", () => {
    const resolution: ModelResolution = { kind: "unknown_qualifier", qualifier: "kimee" };
    const result = decideRoute("POST", "/v1/messages", resolution);
    assert.equal(result.kind, "unknown_provider");
    if (result.kind === "unknown_provider") {
      assert.equal(result.qualifier, "kimee");
    }
  });
});
