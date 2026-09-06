import {
  defineTool,
  type ExtensionAPI,
  type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import {
  PROVIDER_EVENT,
  type CooperativeProviderRequest,
} from "../src/index.ts";
import type {
  NestedContext,
  ToolCapabilities,
  ToolProvider,
} from "../src/bridge/types.ts";

const mockA = defineTool({
  name: "mock_a",
  label: "Mock A",
  description: "Return a labelled value for the cooperative provider example",
  parameters: Type.Object({ value: Type.String() }, { additionalProperties: false }),
  async execute(_toolCallId, params) {
    return {
      content: [{ type: "text", text: `A:${params.value}` }],
      details: { source: "mock_a" },
    };
  },
});

const mockB = defineTool({
  name: "mock_b",
  label: "Mock B",
  description: "Add two numbers for the cooperative provider example",
  parameters: Type.Object({ left: Type.Number(), right: Type.Number() }, { additionalProperties: false }),
  async execute(_toolCallId, params) {
    return {
      content: [{ type: "text", text: String(params.left + params.right) }],
      details: { source: "mock_b" },
    };
  },
});

const definitions = new Map<string, ToolDefinition>([
  [mockA.name, mockA],
  [mockB.name, mockB],
]);

const capabilities: ToolCapabilities = {
  code: true,
  notebook: true,
  interactive: false,
  approval: false,
  parallel: true,
  cancellable: true,
  nested: true,
};

export default function cooperativeToolsExample(pi: ExtensionAPI): void {
  pi.registerTool(mockA);
  pi.registerTool(mockB);

  const provider: ToolProvider = {
    list: () => pi.getAllTools().filter((tool) => definitions.has(tool.name)),
    resolve(name) {
      const definition = definitions.get(name);
      return definition ? { definition, capabilities } : undefined;
    },
    async preflight(name, _args, context) {
      context.signal.throwIfAborted();
      if (!definitions.has(name)) throw new Error(`Nested tool is not allowlisted: ${name}`);
      if (name === "repl_notebook") throw new Error("Recursive repl_notebook calls are forbidden");
      if (context.context.cwd !== context.cwd) throw new Error("Nested cwd changed during preflight");
      // Real integrations place approval, audit, path and tenancy policy here.
    },
    async invoke(name, args, context) {
      const definition = definitions.get(name);
      if (!definition) throw new Error(`Unknown cooperative tool: ${name}`);
      return definition.execute(
        context.toolCallId,
        args as never,
        context.signal,
        (update) => context.onUpdate(update),
        context.context,
      );
    },
  };

  pi.events.on(PROVIDER_EVENT, (data) => {
    // accept(provider) must run synchronously. Do not await before this call.
    (data as CooperativeProviderRequest).accept(provider);
  });
}

// This example invokes the real definitions directly only after explicit preflight.
// Raw ToolDefinition.execute does not automatically preserve Pi event middleware.
// Production hosts must migrate required policy into preflight/invoke or deny the tool.
