/** Synthetic metadata and injected time; no cloud usage or inference. */
import { it } from "node:test";
import assert from "node:assert/strict";
import { QuotaStore } from "../../src/routing/quota-store.js";
import {
  UsageCoordinator,
  type UsageSnapshot,
} from "../../src/routing/usage-coordinator.js";
import type { AllowanceScope } from "../../src/routing/routing-types.js";

it("retains a newer inference blocker when metadata was requested in the same clock millisecond", async () => {
  const scope: AllowanceScope = {
    provider: "kimi",
    product: "kimi-code",
    account: "synthetic",
    allowanceGroup: "kimi-code",
  };
  const quota = new QuotaStore({
    now: () => 1000,
    monotonic: () => 1000,
    random: () => 0.5,
  });
  let finish!: (value: UsageSnapshot) => void;
  const usage = new UsageCoordinator(
    quota,
    async () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  const pending = usage.refresh(scope);
  quota.fail({
    kind: "quota",
    scope,
    windows: [
      { id: "weekly", exhausted: true, observedAt: 1000, source: "inference" },
    ],
    evidence: "documented",
    bodyTruncated: false,
    responseCommitted: false,
  });
  finish({
    windows: [
      { id: "weekly", exhausted: false, observedAt: 1000, source: "usage" },
    ],
    complete: true,
    serviceableCredits: true,
  });
  assert.equal(await pending, false);
  assert.equal(quota.readiness(scope), "exhausted");
  assert.equal(quota.observations(scope)[0]!.exhausted, true);
  usage.close();
});
