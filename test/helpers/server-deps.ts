import { buildDeps, type ProviderDepsById } from "../../src/server.js";

const refusingProviderDeps = (refused: string[]): ProviderDepsById => ({
  codex: undefined,
  together: {
    // Select the store call on every test platform.
    env: {}, platform: "darwin", setTimer: () => () => {},
    exec: async () => {
      refused.push("together.exec");
      throw new Error("Unexpected Keychain call: inject the Together deps");
    },
  },
});

type TestOptions = NonNullable<Parameters<typeof buildDeps>[2]> & { readonly refusedStoreCalls?: string[] };

/** Use the Together fake unless the test supplies its own deps. */
export const buildTestDeps = (
  config: Parameters<typeof buildDeps>[0], logger?: Parameters<typeof buildDeps>[1],
  { refusedStoreCalls = [], providerDeps, ...options }: TestOptions = {},
): ReturnType<typeof buildDeps> => buildDeps(config, logger, {
  ...options,
  providerDeps: { ...refusingProviderDeps(refusedStoreCalls), ...providerDeps },
});
