/** Count data-only JSON without constructing an escaped serialization or invoking user code. */
export function jsonStringBytes(value: string, start = 0, end = value.length): number {
  let bytes = 2;
  for (let i = start; i < end; i++) {
    const n = value.charCodeAt(i);
    if (n === 34 || n === 92 || n === 8 || n === 9 || n === 10 || n === 12 || n === 13) bytes += 2;
    else if (n < 32) bytes += 6;
    else if (n < 128) bytes++;
    else if (n < 2048) bytes += 2;
    else if (n >= 0xd800 && n <= 0xdbff && i + 1 < end &&
      value.charCodeAt(i + 1) >= 0xdc00 && value.charCodeAt(i + 1) <= 0xdfff) { bytes += 4; i++; }
    else bytes += n >= 0xd800 && n <= 0xdfff ? 6 : 3;
  }
  return bytes;
}

/** Internal JSON data may alias and omit undefined object fields; cycles/accessors are rejected. */
export function jsonBytes(root: unknown, maxBytes: number): number {
  const stack: { value?: unknown; leave?: object }[] = [{ value: root }];
  const active = new WeakSet<object>();
  let bytes = 0;
  while (stack.length) {
    const task = stack.pop()!;
    if (task.leave) { active.delete(task.leave); continue; }
    const value = task.value;
    if (typeof value === "string") bytes += jsonStringBytes(value);
    else if (value === null || value === undefined) bytes += 4;
    else if (typeof value === "boolean") bytes += value ? 4 : 5;
    else if (typeof value === "number") bytes += Number.isFinite(value) ? String(value).length : 4;
    else {
      if (typeof value !== "object" || active.has(value)) throw new TypeError("invalid_json_data");
      const array = Array.isArray(value), prototype = Object.getPrototypeOf(value);
      if (array ? prototype !== Array.prototype : prototype !== Object.prototype && prototype !== null)
        throw new TypeError("invalid_json_data");
      active.add(value); stack.push({ leave: value });
      const descriptors = Object.getOwnPropertyDescriptors(value);
      const toJSON = descriptors["toJSON"];
      if (toJSON && (!("value" in toJSON) || typeof toJSON.value === "function")) throw new TypeError("invalid_json_data");
      bytes += 2;
      let count = 0;
      const add = (key: string, child: unknown) => {
        if (count++) bytes++;
        if (!array) bytes += jsonStringBytes(key) + 1;
        if (bytes > maxBytes) throw new RangeError("json_data_too_large");
        stack.push({ value: child });
      };
      if (array) {
        for (let i = 0; i < value.length; i++) {
          const d = descriptors[String(i)];
          if (d && !("value" in d)) throw new TypeError("invalid_json_data");
          add(String(i), d?.value);
        }
      } else for (const [key, d] of Object.entries(descriptors)) {
        if (!d.enumerable) continue;
        if (!("value" in d)) throw new TypeError("invalid_json_data");
        if (d.value !== undefined) add(key, d.value);
      }
    }
    if (bytes > maxBytes) throw new RangeError("json_data_too_large");
  }
  return bytes;
}
