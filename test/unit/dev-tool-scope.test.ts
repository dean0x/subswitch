import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { it } from "node:test";

it("keeps the e2e capture tools out of the build and the package files", () => {
  const readRepoJson = (name: string): unknown => JSON.parse(readFileSync(new URL(`../../${name}`, import.meta.url), "utf8"));
  const build = readRepoJson("tsconfig.build.json") as { compilerOptions?: { rootDir?: string }; include?: unknown };
  // rootDir also fails the build when a src file imports a file outside src.
  assert.equal(build.compilerOptions?.rootDir, "src");
  assert.deepEqual(build.include, ["src/**/*.ts"]);
  const pkg = readRepoJson("package.json") as { files?: unknown };
  assert.ok(Array.isArray(pkg.files) && pkg.files.length > 0, "package.json must list the files it ships");
  for (const entry of pkg.files as unknown[]) {
    // Refuse e2e, a path under e2e, a leading glob and the repository root.
    assert.ok(typeof entry === "string" && !/^(?:\.?\/)?(?:e2e(?:\/|$)|\*|\.?\/?$)/u.test(entry), `package file entry: ${String(entry)}`);
  }
});
