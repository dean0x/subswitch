import type { Config } from "../config.js";
import {
  DESTINATIONS,
  defaultBase,
  KIMI_MODELS,
} from "./destination-catalog.js";
import { MODEL_REGISTRY } from "../models.js";
import { CLAUDE_MODELS } from "../claude-models.js";
import type { OriginatingClient } from "./routing-types.js";
import { routeChain } from "./routing-config.js";

/** No credential reads, authentication refresh, quota lookup or inference. */
export function routingDiscovery(
  config: Config,
  client: OriginatingClient | "all",
) {
  return {
    kind: "models",
    schemaVersion: 3,
    client,
    providers: DESTINATIONS.map((d) => ({
      ...d,
      compatibility:
        d.id === "kimi" ? "live-unverified" : "existing-translators",
    })),
    models: {
      codex: MODEL_REGISTRY.map((m) => m.id),
      claude: CLAUDE_MODELS.map((m) => m.id),
      kimi: KIMI_MODELS,
    },
    profiles: Object.entries(config.accessProfiles ?? {}).map(([id, p]) => ({
      id,
      provider: p.provider,
      product: p.product,
      billing: p.billing,
      region: p.region,
      endpoint: p.baseUrl ?? defaultBase(p),
      availability: "unknown",
    })),
    routes: Object.entries(config.routes ?? {})
      .filter(([, r]) => client === "all" || r.clients.includes(client))
      .map(([id, r]) => ({
        id,
        clients: r.clients,
        targets: routeChain(r),
        affinity: r.affinity,
        transientTriggers: r.transientTriggers,
      })),
    lifecycle: {
      nativeCertification: "unverified",
      explicit: "run-action",
      interactiveBoundary: "one-native-invocation",
    },
  };
}
