import { buildDeps, type ProviderDepsById } from "../../src/server.js";
import type { KimiStoreDeps } from "../../src/kimi-native-auth.js";
import type { KimiNativeStore } from "../../src/kimi-native-store.js";

/**
 * A Kimi fake whose store members, the queue key included, its fetch and its clock record
 * the call and throw. Making the store is not a call: it reads nothing.
 */
const refusingKimiDeps = (refused: string[]): KimiStoreDeps => {
  const refuse = (call: string): never => {
    refused.push(`kimi.${call}`);
    throw new Error("Unexpected Kimi store call: inject the Kimi deps");
  };
  const store: KimiNativeStore = {
    get coordinationKey(): string {
      return refuse("coordinationKey");
    },
    read: async () => refuse("read"),
    readMarker: async () => refuse("readMarker"),
    withLease: async () => refuse("withLease"),
  };
  return { openStore: () => store, fetch: async () => refuse("fetch"), now: () => refuse("now") };
};

const refusingGeminiDeps = (refused: string[]): ProviderDepsById["gemini"] => {
  const refuse = (call: string): never => {
    refused.push(`gemini.${call}`);
    throw new Error("Unexpected Gemini call: inject the Gemini deps");
  };
  return {
    reader: { probe: async () => refuse("probe"), readSecret: async () => refuse("readSecret") },
    fetch: async () => refuse("fetch"),
  };
};

/** The default test deps: each one records an unexpected call in `refused` and throws. */
export const refusingProviderDeps = (refused: string[]): ProviderDepsById => ({
  codex: undefined,
  together: {
    // Select the store call on every test platform.
    env: {}, platform: "darwin", setTimer: () => () => {},
    exec: async () => {
      refused.push("together.exec");
      throw new Error("Unexpected Keychain call: inject the Together deps");
    },
  },
  kimi: refusingKimiDeps(refused),
  gemini: refusingGeminiDeps(refused),
});

type TestOptions = NonNullable<Parameters<typeof buildDeps>[2]> & { readonly refusedStoreCalls?: string[] };

/** Use the refusing fakes unless the test supplies its own deps. */
export const buildTestDeps = (
  config: Parameters<typeof buildDeps>[0], logger?: Parameters<typeof buildDeps>[1],
  { refusedStoreCalls = [], providerDeps, ...options }: TestOptions = {},
): ReturnType<typeof buildDeps> => buildDeps(config, logger, {
  ...options,
  providerDeps: { ...refusingProviderDeps(refusedStoreCalls), ...providerDeps },
});
