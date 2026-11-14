/**
 * Disabled Responses exec lifecycle/projection. Used only by an explicit internal
 * validator context; no production entrypoint constructs one. No IO or execution.
 */
import { isDeepStrictEqual } from "node:util";
import type { SseEvent } from "../codex-response.js";
import { object } from "../plain-object.js";
import { parseKimiExecArguments } from "./kimi-exec-codec.js";
import { KimiExecPending, type KimiExecReservation } from "./kimi-exec-pending.js";
import { RoutingError, type Item } from "./routing-types.js";

interface Lifecycle {
  index: number;
  added: Item;
  deltas: string[];
  argumentsDone?: string;
  source?: string;
  done?: Item;
}
interface Raw { event: SseEvent; value: Item; }
type Step = { kind: "prefix" } | { kind: "held" } | {
  kind: "terminal"; events: readonly SseEvent[]; final: Item; calls: readonly Item[];
};
function fail(): never { throw new RoutingError("invalid_provider_tool_lifecycle", 502); }
const own = (v: Item, key: string) => Object.hasOwn(v, key);
const text = (v: unknown): v is string => typeof v === "string" && v.length > 0;
const tool = (v: Item) => ["function_call", "custom_tool_call"].includes(String(v["type"]));
const closed = (v: Item, keys: readonly string[]) => Object.keys(v).every(key => keys.includes(key));
const toolFields = ["type", "id", "call_id", "name", "namespace", "status", "arguments", "input"];
const eventFields = ["type", "sequence_number", "response_id", "output_index", "item", "item_id", "call_id", "name", "namespace", "status", "delta", "arguments", "input"];

export class KimiExecStream {
  readonly pending: KimiExecPending;
  private raw: Raw[] = [];
  private states = new Map<number, Lifecycle>();
  private byId = new Map<string, number>();
  private byCall = new Set<string>();
  private reservations: KimiExecReservation[] = [];
  private projected: SseEvent[] = [];
  private nativeFinal: Item | undefined;
  private nativeCalls: Item[] = [];
  private barrier = false;
  private ended = false;
  private disposed = false;
  private refusal = false;

  constructor(pending = new KimiExecPending()) { this.pending = pending; }

  private retain(value: unknown): void { this.reservations.push(this.pending.retain(value)); }
  private index(value: unknown): number {
    if (!Number.isInteger(value) || (value as number) < 0 || (value as number) >= 1024) return fail();
    return value as number;
  }
  private callItem(item: Item, completed: boolean): void {
    const field = item["type"] === "function_call" ? "arguments" : "input";
    if (!closed(item, toolFields) || !text(item["id"]) || !text(item["call_id"]) || !text(item["name"]) ||
      item["status"] !== (completed ? "completed" : "in_progress") || typeof item[field] !== "string" ||
      own(item, field === "arguments" ? "input" : "arguments") ||
      (own(item, "namespace") && typeof item["namespace"] !== "string") ||
      (!completed && item[field] !== "") ||
      (item["name"] === "exec" && (item["type"] !== "function_call" || own(item, "namespace")))) fail();
  }
  private identifiers(value: Item, state: Lifecycle, completed: boolean): void {
    const item = state.added;
    for (const [field, expected] of [["output_index", state.index], ["item_id", item["id"]],
      ["call_id", item["call_id"]], ["name", item["name"]], ["namespace", item["namespace"]],
      ["status", completed ? "completed" : "in_progress"]] as const) {
      if (own(value, field) && (value[field] !== expected ||
        (field === "namespace" && !own(item, "namespace")))) fail();
    }
  }
  private argumentState(value: Item, completed: boolean): Lifecycle {
    if (!closed(value, eventFields) || !text(value["item_id"])) return fail();
    // Never pick one matching identifier while ignoring a conflicting supplied one.
    const index = this.byId.get(value["item_id"]);
    const state = index === undefined ? undefined : this.states.get(index);
    if (!state || !tool(state.added) || state.done || state.argumentsDone !== undefined) return fail();
    this.identifiers(value, state, completed);
    const custom = state.added["type"] === "custom_tool_call";
    if (String(value["type"]) !== `response.${custom ? "custom_tool_call_input" : "function_call_arguments"}.${completed ? "done" : "delta"}`)
      return fail();
    return state;
  }

  /** Prefix stays streaming. The first item/tool event starts the unreordered raw suffix. */
  accept(event: SseEvent, value: Item, responseId: string): Step {
    if (this.ended || this.disposed) return fail();
    const type = String(value["type"]);
    if ((event.event !== undefined && event.event !== type) ||
      (own(value, "response_id") && value["response_id"] !== responseId)) fail();
    if (type === "response.refusal.delta" || type === "response.refusal.done") {
      this.refusal = true;
      if ([...this.states.values()].some(s => tool(s.added))) fail();
    }
    if (type === "response.created" || type === "response.in_progress") {
      const response = object(value["response"]);
      if (!response || response["id"] !== responseId || response["status"] !== "in_progress" ||
        !Array.isArray(response["output"]) || response["output"].length !== 0) fail();
    } else if (own(value, "response") && !["response.completed", "response.incomplete"].includes(type)) fail();
    if (own(value, "item") && !["response.output_item.added", "response.output_item.done"].includes(type)) fail();
    if (type === "response.output_item.added" || type === "response.output_item.done" ||
      type.startsWith("response.function_call_arguments.") || type.startsWith("response.custom_tool_call_input."))
      this.barrier = true;
    if (this.barrier) {
      this.retain({ event, value }); // Raw SSE text + parsed object both remain owned until generator cleanup.
      this.raw.push({ event, value });
    }

    if (type === "response.output_item.added") {
      const index = this.index(value["output_index"]), item = object(value["item"]);
      if (!item || !closed(value, eventFields) || own(value, "arguments") || own(value, "input") || own(value, "delta") ||
        !text(item["id"]) || this.states.has(index) || this.byId.has(item["id"]) ||
        !["message", "reasoning", "function_call", "custom_tool_call"].includes(String(item["type"]))) fail();
      if (tool(item)) {
        if (this.refusal) fail();
        this.callItem(item, false);
        if (this.byCall.has(item["call_id"] as string)) fail();
      } else if (own(item, "status") && item["status"] !== "in_progress") fail();
      const state: Lifecycle = { index, added: item, deltas: [] };
      this.identifiers(value, state, false);
      this.retain([index, state]);
      this.retain([item["id"], index, tool(item) ? item["call_id"] : null]);
      this.states.set(index, state);
      this.byId.set(item["id"], index);
      if (tool(item)) this.byCall.add(item["call_id"] as string);
    } else if (type.endsWith(".delta") && (type.startsWith("response.function_call_arguments.") || type.startsWith("response.custom_tool_call_input."))) {
      const state = this.argumentState(value, false);
      if (typeof value["delta"] !== "string" || own(value, "arguments") || own(value, "input") || own(value, "item")) fail();
      // Retain segments and join once at done; do not copy/stringify the growing
      // accumulated prefix for every tiny delta (quadratic work).
      this.retain([value["delta"]]);
      state.deltas.push(value["delta"]);
    } else if (type === "response.function_call_arguments.done" || type === "response.custom_tool_call_input.done") {
      const state = this.argumentState(value, true), field = state.added["type"] === "function_call" ? "arguments" : "input";
      const source = value[field];
      if (typeof source !== "string" || own(value, field === "arguments" ? "input" : "arguments") || own(value, "delta") || own(value, "item")) fail();
      if (state.deltas.length > 0) {
        const joined = state.deltas.join("");
        const temporary = this.pending.retain(joined);
        try { if (source !== joined) fail(); } finally { temporary.release(); }
      }
      let decoded: string | undefined;
      if (state.added["name"] === "exec") {
        const parsed = parseKimiExecArguments(source);
        if (parsed.kind !== "parsed") return fail();
        decoded = parsed.source;
      } else if (field === "arguments") {
        try { if (!object(JSON.parse(source))) fail(); } catch { fail(); }
      }
      this.retain({ argumentsDone: source, ...(decoded === undefined ? {} : { source: decoded }) });
      state.argumentsDone = source;
      if (decoded !== undefined) state.source = decoded;
    } else if (type === "response.output_item.done") {
      const state = this.states.get(this.index(value["output_index"])), item = object(value["item"]);
      if (!state || state.done || !item || !closed(value, eventFields) || own(value, "arguments") || own(value, "input") || own(value, "delta")) return fail();
      this.identifiers(value, state, true);
      if (item["type"] !== state.added["type"] || item["id"] !== state.added["id"]) fail();
      if (tool(item)) {
        this.callItem(item, true);
        const field = item["type"] === "function_call" ? "arguments" : "input";
        if (state.argumentsDone === undefined || item[field] !== state.argumentsDone ||
          ["name", "call_id", "namespace"].some(k => item[k] !== state.added[k] || own(item, k) !== own(state.added, k))) fail();
      } else if (own(item, "status") && item["status"] !== "completed") fail();
      this.retain({ done: item });
      state.done = item;
    } else if (type === "response.completed" || type === "response.incomplete") {
      const final = object(value["response"]), output = final?.["output"];
      if (!final || final["id"] !== responseId || final["status"] !== (type === "response.completed" ? "completed" : "incomplete") ||
        (final["error"] !== undefined && final["error"] !== null) ||
        (type === "response.completed" && final["incomplete_details"] !== undefined && final["incomplete_details"] !== null) ||
        !Array.isArray(output) || output.length > 1024) return fail();
      const ids = new Set<string>(), calls = new Set<string>();
      for (let index = 0; index < output.length; index++) {
        const item = object(output[index]);
        if (!item || !["message", "reasoning", "function_call", "custom_tool_call"].includes(String(item["type"])) ||
          !text(item["id"]) || ids.has(item["id"])) return fail();
        ids.add(item["id"]);
        const state = this.states.get(index);
        if (state && (!state.done || !isDeepStrictEqual(state.done, item))) fail();
        if (tool(item)) {
          this.callItem(item, true);
          if (type !== "response.completed" || !state || !text(item["call_id"]) || calls.has(item["call_id"])) return fail();
          calls.add(item["call_id"]);
        }
      }
      for (const state of this.states.values()) if (!state.done || state.index >= output.length) fail();
      if (type === "response.incomplete" && [...this.states.values()].some(s => tool(s.added))) fail();
      this.ended = true;
      return this.project(final, event, value);
    } else {
      // A text/reasoning event cannot smuggle an alternate tool payload or refer
      // to a known tool's identity under another event kind.
      const index = typeof value["item_id"] === "string" ? this.byId.get(value["item_id"]) : undefined;
      const state = index === undefined ? undefined : this.states.get(index);
      const indexed = own(value, "output_index") ? this.states.get(this.index(value["output_index"])) : undefined;
      if (own(value, "call_id") || (state && tool(state.added)) || (indexed && tool(indexed.added)) ||
        (state && indexed && state !== indexed) || (indexed && own(value, "item_id") && value["item_id"] !== indexed.added["id"])) fail();
    }
    return { kind: this.barrier ? "held" : "prefix" };
  }

  private mappedExec(state: Lifecycle): state is Lifecycle & { source: string } {
    return state.added["type"] === "function_call" && state.added["name"] === "exec" &&
      !own(state.added, "namespace") && state.argumentsDone !== undefined &&
      state.done !== undefined && typeof state.source === "string";
  }
  private native(item: Item, state: Lifecycle, added = false): Item {
    if (!this.mappedExec(state)) return item;
    const { arguments: _arguments, ...rest } = item;
    return { ...rest, type: "custom_tool_call", input: added ? "" : state.source };
  }
  private project(final: Item, terminal: SseEvent, value: Item): Step {
    const output = (final["output"] as Item[]).map((item, i) => {
      const state = this.states.get(i);
      return state ? this.native(item, state) : item;
    });
    this.retain(output);
    this.nativeFinal = { ...final, output };
    this.retain(this.nativeFinal);
    this.nativeCalls = output.filter((_item, i) => {
      const state = this.states.get(i);
      return state !== undefined && this.mappedExec(state);
    });
    this.retain(this.nativeCalls);
    // No tool barrier means terminal-only text can remain a streamed prefix.
    const records = this.barrier ? this.raw : [{ event: terminal, value }];
    for (const raw of records) {
      const original = raw.value, type = String(original["type"]);
      let projected = original;
      if (type === "response.output_item.added" || type === "response.output_item.done") {
        const state = this.states.get(original["output_index"] as number)!;
        if (this.mappedExec(state))
          projected = { ...original, item: this.native(original["item"] as Item, state, type.endsWith(".added")) };
      } else if (type.startsWith("response.function_call_arguments.")) {
        const state = this.states.get(this.byId.get(original["item_id"] as string)!)!;
        if (this.mappedExec(state)) {
          if (type.endsWith(".delta")) continue;
          const { arguments: _arguments, ...rest } = original;
          projected = { ...rest, type: "response.custom_tool_call_input.done", input: state.source };
        }
      } else if (type === "response.completed" || type === "response.incomplete")
        projected = { ...original, response: this.nativeFinal };
      const event = projected === original ? raw.event : {
        event: raw.event.event === undefined ? undefined : String(projected["type"]), data: JSON.stringify(projected),
      };
      // Count every retained projected representation alongside raw/lifecycle,
      // including unchanged records referenced by this second ordered array.
      this.retain(event);
      this.projected.push(event);
    }
    return { kind: "terminal", events: this.projected, final: this.nativeFinal, calls: this.nativeCalls };
  }

  /** Call only after generator-owned raw/projected locals are no longer suspended at a yield. */
  dispose(): void {
    this.raw.length = 0;
    this.projected.length = 0;
    this.states.clear();
    this.byId.clear();
    this.byCall.clear();
    this.nativeFinal = undefined;
    this.nativeCalls.length = 0;
    for (const reservation of this.reservations) reservation.release();
    this.reservations.length = 0;
    this.disposed = true;
  }
}
