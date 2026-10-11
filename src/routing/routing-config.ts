import { z } from "zod";
import {
  DESTINATIONS,
  defaultBase,
  modelEfforts,
  VERIFIED_MODEL_EQUIVALENCES,
} from "./destination-catalog.js";
import type { AccessProfile, RoutePolicy } from "./routing-types.js";
import { ownValue } from "../plain-object.js";

const label = z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/);
export const AccessProfilesSchema = z
  .record(
    label,
    z.strictObject({
      provider: z.enum(["codex", "claude", "kimi"]),
      product: z.enum([
        "chatgpt-codex",
        "openai-api",
        "claude-code",
        "anthropic-api",
        "kimi-code",
        "kimi-platform",
      ]),
      region: z.enum(["mainland-cn", "global"]).optional(),
      billing: z.enum(["subscription", "api"]),
      account: label,
      credential: z.discriminatedUnion("kind", [
        z.strictObject({
          kind: z.literal("env"),
          name: z.string().regex(/^[A-Z_][A-Z0-9_]{0,127}$/),
        }),
        z.strictObject({
          kind: z.literal("native-oauth"),
          authFile: z.string().min(1),
        }),
      ]),
      baseUrl: z.url().optional(),
      allowInsecureBaseUrl: z.boolean().optional(),
    }),
  )
  .default({});
const target = z.strictObject({
  profile: label,
  model: z.string().min(1).max(200),
  effort: label,
});
export const RoutesSchema = z
  .record(
    label,
    z.strictObject({
      clients: z.array(z.enum(["claude-code", "codex"])).min(1),
      primary: target,
      sameModelApi: target.optional(),
      fallbacks: z.array(target).max(64).default([]),
      transientTriggers: z.array(z.enum(["overload", "transport"])).default([]),
      affinity: z.literal("native-or-explicit").default("native-or-explicit"),
    }),
  )
  .default({});

export function validateExplicitConfig(
  profiles: Record<string, AccessProfile>,
  routes: Record<string, RoutePolicy>,
  loopback: (host: string) => boolean,
): string[] {
  const errors: string[] = [];
  for (const [id, p] of Object.entries(profiles)) {
    if (
      !DESTINATIONS.find((d) => d.id === p.provider)?.products.includes(
        p.product,
      )
    )
      errors.push(`${id}: invalid_product`);
    const subscription = ["chatgpt-codex", "claude-code", "kimi-code"].includes(
      p.product,
    );
    if ((p.billing === "subscription") !== subscription)
      errors.push(`${id}: billing_product_mismatch`);
    if (p.provider === "kimi" ? !p.region : p.region !== undefined)
      errors.push(`${id}: region_product_mismatch`);
    if (
      (p.credential.kind === "native-oauth") !==
      ["chatgpt-codex", "claude-code"].includes(p.product)
    )
      errors.push(`${id}: credential_product_mismatch`);
    const url = new URL(p.baseUrl ?? defaultBase(p));
    const expected = new URL(defaultBase(p));
    const knownHosts =
      p.provider === "kimi"
        ? ["api.kimi.ai", "api.kimi.com", "api.moonshot.ai", "api.moonshot.cn"]
        : p.provider === "codex"
          ? ["chatgpt.com", "api.openai.com"]
          : ["api.anthropic.com"];
    if (
      knownHosts.includes(url.hostname) &&
      (url.hostname !== expected.hostname ||
        url.pathname.replace(/\/$/, "") !==
          expected.pathname.replace(/\/$/, ""))
    )
      errors.push(
        `${id}: endpoint_product_or_region_mismatch; baseUrl must be the product root`,
      );
    if (
      !["https:", "http:"].includes(url.protocol) ||
      url.username ||
      url.password ||
      url.search ||
      url.hash ||
      (url.protocol !== "https:" && !loopback(url.hostname))
    )
      errors.push(`${id}: unsafe_endpoint`);
    if (
      url.hostname !== new URL(defaultBase(p)).hostname &&
      !loopback(url.hostname) &&
      !p.allowInsecureBaseUrl
    )
      errors.push(`${id}: endpoint_host_opt_in_required`);
  }
  for (const [name, route] of Object.entries(routes)) {
    const targets = [
      route.primary,
      ...(route.sameModelApi ? [route.sameModelApi] : []),
      ...route.fallbacks,
    ];
    const seen = new Set<string>();
    for (const t of targets) {
      seen.add(JSON.stringify([t.profile, t.model, t.effort]));
      const p = ownValue(profiles, t.profile);
      if (!p) {
        errors.push(`${name}: unknown_profile`);
        continue;
      }
      if (Object.hasOwn(routes, t.model)) {
        errors.push(`${name}: route_reference_forbidden`);
        continue;
      }
      const efforts = modelEfforts(p, t.model);
      if (!efforts) errors.push(`${name}: invalid_target_model`);
      else if (!efforts.includes(t.effort))
        errors.push(`${name}: unsupported_effort`);
    }
    if (seen.size > 8) errors.push(`${name}: too_many_targets`);
    if (route.sameModelApi) {
      const primary = ownValue(profiles, route.primary.profile),
        api = ownValue(profiles, route.sameModelApi.profile);
      const key = JSON.stringify([
        primary,
        route.primary.model,
        api,
        route.sameModelApi.model,
      ]);
      if (
        primary?.billing !== "subscription" ||
        api?.billing !== "api" ||
        !VERIFIED_MODEL_EQUIVALENCES.includes(key)
      )
        errors.push(
          `${name}: unverified_model_equivalence; list the API target explicitly in fallbacks`,
        );
    }
  }
  return errors;
}
export const routeChain = (route: RoutePolicy) => {
  const seen = new Set<string>();
  return [
    route.primary,
    ...(route.sameModelApi ? [route.sameModelApi] : []),
    ...route.fallbacks,
  ].filter((t) => {
    const key = JSON.stringify([t.profile, t.model, t.effort]);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
};
