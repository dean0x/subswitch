import { PROVIDER_IDS, type AliasesByProvider } from "../../src/models.js";

/**
 * An alias record with no aliases for each provider id.
 *
 * Built from PROVIDER_IDS, so a new provider id needs no edit in the tests that use it.
 * The cast is needed because a loop over the ids cannot prove to the compiler that every
 * key is present; a test in routing-table.test.ts checks that at runtime. Each call
 * returns a new object, so one test cannot change the record that another test reads.
 */
export const emptyAliases = (): AliasesByProvider =>
  Object.fromEntries(PROVIDER_IDS.map((id) => [id, {}] as const)) as AliasesByProvider;
