import { createKimiAuthStore } from "./kimi-auth-store.js";
import { KimiNativeAuthManager } from "./kimi-native-auth.js";
import type { AccessProfile } from "./routing/routing-types.js";

/** Explicit profiles only; read-only, no login/refresh/metadata/network/native discovery. */
export async function inspectKimiProfiles(profiles: Readonly<Record<string, AccessProfile>>, write: (line: string) => void): Promise<number> {
  let exit = 0;
  for (const [id, profile] of Object.entries(profiles)) {
    if (profile.provider !== "kimi" || profile.credential.kind !== "native-oauth") continue;
    if (profile.credential.source === "kimi-code") {
      try {
        if (!profile.region || profile.product !== "kimi-code") throw new Error("profile");
        const state = await new KimiNativeAuthManager(profile.credential.authFile, profile.region).inspect(AbortSignal.timeout(1000));
        if (state.recoveryRequired) {
          write(`${id} OAuth: renewal outcome unknown; recovery required (a newer native grant is adopted automatically); subscription validity unmeasured`);
          exit = 1;
          continue;
        }
        write(`${id} OAuth: native login stored (automatic renewal${state.renewalDue ? " due" : " available"}); service identity acceptance unverified`);
      } catch { write(`${id} OAuth: native login unavailable (check selected region, private file and login)`); exit = 1; }
      continue;
    }
    try {
      const record = await createKimiAuthStore(profile.credential.authFile).read(AbortSignal.timeout(1000));
      if (record.region !== profile.region) throw new Error("region");
      write(`${id} OAuth: ${record.tokens.expires_at * 1000 > Date.now() ? "stored" : "expired (refresh required)"}; service identity acceptance unverified`);
    } catch { write(`${id} OAuth: unavailable (explicit owned store required)`); exit = 1; }
  }
  return exit;
}
