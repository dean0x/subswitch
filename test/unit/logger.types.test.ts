/**
 * Compile-time proofs for the logger field-key completeness invariant.
 *
 * There are no runtime assertions here -- `npm run typecheck` is the gate, and it covers
 * this file because tsconfig.json includes `test/**\/*.ts`. Everything lives inside a
 * function that is never called, so the file contributes no test cases and executes
 * nothing under `node --test`.
 *
 * The proof uses the same `Exclude<keyof LogFields, (typeof FIELD_KEYS)[number]>` idiom
 * that lived in src/logger.ts as a module-level check. Moving it here follows the
 * project convention: module-level compile-time proofs belong in the *.types.test.ts
 * family (config.types.test.ts, provider-auth.types.test.ts, provider-events.types.test.ts);
 * in-src `const _exhaustive: never` guards are reserved for function-local switch guards.
 *
 * To re-verify: temporarily remove one key from FIELD_KEYS in src/logger.ts and run
 * `npm run typecheck`. You should see:
 *   Type 'true' is not assignable to type 'never'.
 * Restore the key and typecheck should pass clean.
 */
import type { LogFields } from "../../src/logger.js";
import { FIELD_KEYS } from "../../src/logger.js";

const fieldKeysCoversAllLogFields = (): void => {
  // Every key declared in LogFields must appear in FIELD_KEYS.
  // If FIELD_KEYS is missing a key, Exclude<...> is non-never, _FieldKeysComplete
  // resolves to `never`, and the assignment below is a compile error:
  //   Type 'true' is not assignable to type 'never'.
  type _FieldKeysComplete = Exclude<keyof LogFields, (typeof FIELD_KEYS)[number]> extends never ? true : never;
  const _check: _FieldKeysComplete = true;
  void _check;

  // The satisfies annotation on FIELD_KEYS itself (in src/logger.ts) covers the other
  // direction: every value in FIELD_KEYS must be a valid keyof LogFields.
  // Together the two constraints make the mapping a bijection at compile time.
};
void fieldKeysCoversAllLogFields;
