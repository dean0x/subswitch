/** Synthetic usage response. No provider request or real credential is used. */
export const usageBody = (now = 1800000000) => ({
  plan_type: "plus",
  rate_limit: {
    primary_window: { used_percent: 25, limit_window_seconds: 18000, reset_at: now + 10000 },
    secondary_window: { used_percent: 75.5, limit_window_seconds: 604800, reset_at: now + 500000 },
  },
  credits: { has_credits: true, unlimited: false, balance: 12.5 },
  additional_rate_limits: [{ limit_id: "spark", limit_name: "Spark", rate_limit: {
    primary_window: { used_percent: 10, limit_window_seconds: 18000, reset_at: now + 10000 },
  } }],
});
export const expectedUsage = {
  version: 1, observed_at: 1800000000,
  windows: [{ window_minutes: 300, used_percent: 25, resets_at: 1800010000 },
    { window_minutes: 10080, used_percent: 75.5, resets_at: 1800500000 }],
  rate_limit_reached_type: null, source: "usage-endpoint", plan_type: "plus", active_limit: null, limit_name: null,
  credits: { has_credits: true, unlimited: false, balance: 12.5 },
  additional_limits: [{ limit_id: "spark", limit_name: "Spark", windows: [{ window_minutes: 300, used_percent: 10, resets_at: 1800010000 }] }],
} as const;
