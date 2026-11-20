/**
 * Record the file calls of this process whose path is at or inside one folder.
 *
 * The recorder replaces the functions named in FS_FUNCTIONS and FS_PROMISES_FUNCTIONS on
 * node:fs and node:fs/promises, then copies them into the ESM named exports. Each call
 * still runs. It is not a sandbox: it does not see other functions, file handles that are
 * already open, native code or other processes. It checks the first path argument only.
 */
import { createRequire, syncBuiltinESMExports } from "node:module";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

/** The node:fs functions that read, stat, open or make a path. */
export const FS_FUNCTIONS = [
  "access", "accessSync", "exists", "existsSync", "lstat", "lstatSync", "stat", "statSync", "open", "openSync",
  "readFile", "readFileSync", "readdir", "readdirSync", "opendir", "opendirSync", "realpath", "realpathSync",
  "readlink", "readlinkSync", "mkdir", "mkdirSync", "createReadStream", "watch", "watchFile",
] as const;
/** The node:fs/promises functions that read, stat, open or make a path. */
export const FS_PROMISES_FUNCTIONS = [
  "access", "lstat", "stat", "open", "readFile", "readdir", "opendir", "realpath", "readlink", "mkdir", "watch",
] as const;

type Module = Record<string, unknown>;
type Callable = (this: unknown, ...args: unknown[]) => unknown;

const requireBuiltin = createRequire(import.meta.url);
const fs: Module = requireBuiltin("node:fs");
const fsPromises: Module = requireBuiltin("node:fs/promises");

const pathText = (value: unknown): string | undefined => {
  if (typeof value === "string") return value;
  if (value instanceof URL) return value.protocol === "file:" ? fileURLToPath(value) : undefined;
  if (Buffer.isBuffer(value)) return value.toString("utf8");
  return undefined;
};

const isAtOrInside = (folder: string, path: string): boolean => {
  const rel = relative(folder, path);
  return rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
};

/** True while a report runs, so the file calls of `onCall` itself are not reported. */
let reporting = false;

/** Replace `name` on `target` with a function that reports a call inside `folder`. Returns the undo. */
const wrap = (target: Module, name: string, label: string, folder: string,
  onCall: (call: string, path: string) => void): (() => void) => {
  const original = target[name];
  if (typeof original !== "function") throw new Error(`The recorder can not find ${label}`);
  const call = original as Callable;
  const recorded = function (this: unknown, ...args: unknown[]): unknown {
    const text = pathText(args[0]);
    if (!reporting && text !== undefined && isAtOrInside(folder, resolve(text))) {
      reporting = true;
      try {
        onCall(label, resolve(text));
      } finally {
        reporting = false;
      }
    }
    return call.apply(this, args);
  };
  // Keep the added members, such as realpathSync.native and the promisify form of exists.
  for (const key of Reflect.ownKeys(original)) {
    if (key === "length" || key === "name" || key === "prototype") continue;
    const descriptor = Reflect.getOwnPropertyDescriptor(original, key);
    if (descriptor !== undefined) Reflect.defineProperty(recorded, key, descriptor);
  }
  target[name] = recorded;
  return () => { target[name] = original; };
};

/**
 * Report each call of a named file function whose first path argument is at or inside
 * `folder`, as `<module>.<function>` and the resolved path. Returns the function that
 * puts the original functions back.
 */
export const recordFsPaths = (folder: string, onCall: (call: string, path: string) => void): (() => void) => {
  if (!isAbsolute(folder)) throw new Error("The recorded folder must be an absolute path");
  const root = resolve(folder);
  const undo = [
    ...FS_FUNCTIONS.map((name) => wrap(fs, name, `fs.${name}`, root, onCall)),
    ...FS_PROMISES_FUNCTIONS.map((name) => wrap(fsPromises, name, `fs/promises.${name}`, root, onCall)),
  ];
  syncBuiltinESMExports();
  return () => {
    for (const restore of undo) restore();
    syncBuiltinESMExports();
  };
};
