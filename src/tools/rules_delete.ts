import { z } from 'zod';
import { wrapToolCall } from '../lib/wrapToolCall.js';
import type { ToolDefinition } from '../../types/tool.d.js';
import adapter from '../lib/actual-adapter.js';

const InputSchema = z.object({
  id: z.string().describe('Rule ID to delete'),
});

const tool: ToolDefinition = {
  name: 'actual_rules_delete',
  description: `Delete a budget rule from Actual Budget. The rule will no longer be applied to new or existing transactions. This operation cannot be undone.`,
  inputSchema: InputSchema,
  call: wrapToolCall(async (args: unknown, _meta?: unknown) => {
    const input = InputSchema.parse(args || {});
    await adapter.deleteRule(input.id);
    return { success: true };
  }),
};

export default tool;
