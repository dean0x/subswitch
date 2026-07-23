import type { InitFsDeps } from "../../src/init.js";

/**
 * Fake InitFsDeps for unit tests with captured write state.
 *
 * @param existingFiles - Map of path → content for files that "exist" before the test.
 * @param failOnWrite   - When true, writeFile throws instead of writing (simulates disk error).
 */
export const makeFakeDeps = (
  existingFiles: Record<string, string> = {},
  failOnWrite = false,
): InitFsDeps & { written: Record<string, string>; writeOrder: string[] } => {
  const written: Record<string, string> = {};
  const writeOrder: string[] = [];
  return {
    readFile: async (path) => existingFiles[path] ?? null,
    writeFile: async (path, content) => {
      if (failOnWrite) throw new Error("simulated write failure");
      written[path] = content;
      writeOrder.push(path);
    },
    exists: (path) => path in existingFiles,
    written,
    writeOrder,
  };
};
