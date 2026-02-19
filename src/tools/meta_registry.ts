import { z } from 'zod';
import { wrapToolCall } from '../lib/wrapToolCall.js';
import type { ToolDefinition } from '../../types/tool.d.js';
import actualToolsManager from '../actualToolsManager.js';
import { zodToJsonSchema } from 'zod-to-json-schema';

const InputSchema = z.object({
  category: z.string().optional().describe(
    'Optional filter: only return tools whose name contains this substring. ' +
    'E.g., "transactions", "rules", "budgets", "accounts", "categories", "payees", "query", "session".',
  ),
  nameOnly: z.boolean().optional().default(false).describe(
    'If true, return only tool names (lighter payload). Default: false (full metadata).',
  ),
});

const tool: ToolDefinition = {
  name: 'actual_tool_registry',
  description: `List all available Actual Budget tools with their metadata.

This is the discovery endpoint. Use it to find out what tools exist, what they do, and what parameters they accept before calling actual_tool_call.

Returns an array of tool entries, each containing:
- name: the tool identifier to pass to actual_tool_call
- description: what the tool does and usage notes
- inputSchema: JSON Schema describing the required/optional parameters

Use the "category" filter to narrow results (e.g., category: "transactions" returns only transaction tools).
Use nameOnly: true for a lightweight listing of just tool names.

Example workflow:
1. Call actual_tool_registry to discover available tools
2. Call actual_tool_registry with category: "rules" to see rule-related tools
3. Call actual_tool_call with the chosen tool name and arguments`,
  inputSchema: InputSchema,
  call: wrapToolCall(async (args: unknown, _meta?: unknown) => {
    const input = InputSchema.parse(args || {});

    const allNames = actualToolsManager.getToolNames();
    const filtered = input.category
      ? allNames.filter((n) => n.includes(input.category!))
      : allNames;

    if (input.nameOnly) {
      return { tools: filtered, count: filtered.length };
    }

    const tools = filtered.map((name) => {
      const def = actualToolsManager.getTool(name);
      let inputSchema: unknown = { type: 'object', properties: {} };
      try {
        if (def?.inputSchema) {
          inputSchema = zodToJsonSchema(def.inputSchema);
        }
      } catch {
        // fallback to empty schema
      }
      return {
        name,
        description: def?.description || `Tool ${name}`,
        inputSchema,
      };
    });

    return { tools, count: tools.length };
  }),
};

export default tool;
