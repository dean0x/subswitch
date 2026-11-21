import { providerConfigFor, type Credential } from "../../src/config.js";

export const keychainCredential = {
  kind: "native-keychain",
  baseUrl: "https://upstream.example.test/v1",
  defaultHost: "upstream.example.test",
  keychainService: "Fake Codex Sign-in",
  keychainAccount: "fake-account",
  loginCommand: "fixture login",
  renewal: "none",
} as const satisfies Extract<Credential, { kind: "native-keychain" }>;

export const keychainBackedCodex = (
  active: boolean, credential: Extract<Credential, { kind: "native-keychain" }> = keychainCredential,
): typeof providerConfigFor => (config, id) => id === "codex"
  ? { displayName: "Codex", active, ...credential }
  : providerConfigFor(config, id);
