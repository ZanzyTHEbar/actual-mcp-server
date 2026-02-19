import { z } from 'zod';
import { wrapToolCall } from '../lib/wrapToolCall.js';
import type { ToolDefinition } from '../../types/tool.d.js';
import adapter from '../lib/actual-adapter.js';

const InputSchema = z.object({
  id: z.string().describe('Account ID to delete'),
});

type Output = { success: boolean };

const tool: ToolDefinition = {
  name: 'actual_accounts_delete',
  description: 'Delete an account from Actual Budget. Note: The account must not have any transactions. This operation cannot be undone.',
  inputSchema: InputSchema,
  call: wrapToolCall(async (args: unknown, _meta?: unknown) => {
    const input = InputSchema.parse(args || {});
    await adapter.deleteAccount(input.id);
    return { success: true };
  }),
};

export default tool;
