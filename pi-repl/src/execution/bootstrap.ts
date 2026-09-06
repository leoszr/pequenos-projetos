import type { ExecutionIdentity, KernelOutput } from "../kernel/backend.ts";
import type { BindingDeclaration } from "./source.ts";
export const VALUE_MIME = "application/vnd.pi-repl.value+json";
export const SNAPSHOT_MIME = "application/vnd.pi-repl.snapshot+json";
export function bootstrap(url: string, token: string, maxBytes: number): string {
  return `
var __repl = await (async () => {
  const { AsyncLocalStorage } = await import("node:async_hooks");
  const scope = new AsyncLocalStorage();
  const pending = new Set();
  const emit = (data, metadata = {}) => {
    const promise = Deno.jupyter.display(data, { raw: true, metadata });
    pending.add(promise); promise.finally(() => pending.delete(promise));
    return promise;
  };
  const call = async (type, name, args) => {
    const identity = scope.getStore();
    if (!identity) throw new Error("No execution context; background tool calls require an active origin");
    const requestId = crypto.randomUUID();
    const body = JSON.stringify({ version:1, type, requestId, ...identity, name, args });
    if (new TextEncoder().encode(body).length > ${maxBytes}) throw new Error("Bridge payload limit");
    const response = await fetch(${JSON.stringify(url)}, {method:"POST",headers:{authorization:${JSON.stringify(`Bearer ${token}`)},"content-type":"application/json"},body});
    const result = await response.json();
    if (result.version !== 1 || result.requestId !== requestId) throw new Error("Incompatible bridge response");
    if (!result.ok) throw new Error(result.error);
    return result.value;
  };
  return { scope, emit, call, drain: async () => { await Promise.all([...pending]); },
    value: (value) => emit({${JSON.stringify(VALUE_MIME)}: value === undefined ? null : value}),
  };
})();
var tools = new Proxy(Object.create(null), {get: (_, name) => name === "then" ? undefined : name === "$list" ? () => __repl.call("tools") : (args) => __repl.call("call", name, args)});
var text = (value) => __repl.emit({"text/plain":String(value)});
var display = (data, metadata = {}) => __repl.emit(data, metadata);
`;
}
export function enter(identity: ExecutionIdentity): string { return `__repl.scope.enterWith(${JSON.stringify(identity)});\n`; }
export function valueFrom(outputs: KernelOutput[], mime = VALUE_MIME): unknown {
  return outputs.findLast(o => o.data && Object.hasOwn(o.data, mime))?.data?.[mime];
}
/** Conservative by-value codec: reject values whose JSON roundtrip changes semantics. */
export function snapshotSource(bindings: BindingDeclaration[], bindingBytes: number): string {
  return `await (async () => {
    const owners = new Map(); const conflicts = new Set(); let visited = 0;
    const check = (value, owner, stack = new Set()) => {
      if (value === null || typeof value === "string" || typeof value === "boolean") return;
      if (typeof value === "number" && Number.isFinite(value) && !Object.is(value, -0)) return;
      if (typeof value !== "object") throw new Error("Not a JSON-restorable value: " + typeof value);
      if (++visited > ${Math.max(1024, bindingBytes)}) throw new Error("Binding inspection limit");
      if (stack.has(value)) throw new Error("Cyclic reference");
      if (owners.has(value)) { conflicts.add(owner); conflicts.add(owners.get(value)); }
      owners.set(value, owner);
      const proto = Object.getPrototypeOf(value);
      if (proto !== Object.prototype && proto !== Array.prototype) throw new Error("Non-plain prototype/resource");
      if (!Object.isExtensible(value)) throw new Error("Non-extensible object");
      stack.add(value);
      const keys = Reflect.ownKeys(value);
      if (Array.isArray(value) && keys.length !== value.length + 1) throw new Error("Sparse or extended array");
      for (const key of keys) {
        if (Array.isArray(value) && key === "length") continue;
        if (typeof key !== "string") throw new Error("Symbol property");
        if (["__proto__","prototype","constructor"].includes(key)) throw new Error("Unsafe property name");
        const d = Object.getOwnPropertyDescriptor(value, key);
        if (!d || !d.enumerable || !d.writable || !d.configurable || !("value" in d)) throw new Error("Non-plain property descriptor");
        check(d.value, owner, stack);
      }
      stack.delete(value);
    };
    const entries = [];
    ${bindings.map(({ name, declaration }) => `["function","class","import","enum"].includes(${JSON.stringify(declaration)}) ? entries.push({name:${JSON.stringify(name)},declaration:${JSON.stringify(declaration)},status:"excluded",reason:"Declaration semantics cannot be restored faithfully by value"}) : (() => { try { const value = ${name}; check(value, ${JSON.stringify(name)}); const encoded = JSON.stringify(value); if (new TextEncoder().encode(encoded).length > ${bindingBytes}) throw new Error("Binding size limit"); entries.push({ name:${JSON.stringify(name)}, declaration:${JSON.stringify(declaration)}, status:"saved", value:JSON.parse(encoded) }); } catch(error) { entries.push({name:${JSON.stringify(name)},declaration:${JSON.stringify(declaration)},status:"excluded",reason:String(error)}); } })();`).join("\n")}
    for (const entry of entries) if (conflicts.has(entry.name)) { entry.status="excluded"; entry.reason="Shared object identity across bindings"; delete entry.value; }
    await __repl.emit({${JSON.stringify(SNAPSHOT_MIME)}: {bindings:entries, runtime:{name:"deno",version:Deno.version.deno}}});
  })();`;
}
