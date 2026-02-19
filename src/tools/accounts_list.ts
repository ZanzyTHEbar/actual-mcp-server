import { z } from 'zod';
import { wrapToolCall } from '../lib/wrapToolCall.js';
import type { ToolDefinition } from '../../types/tool.d.js';
import { getCachedAccounts } from '../lib/cachedRefs.js';

const InputSchema = z.object({});

const tool: ToolDefinition = {
  name: 'actual_accounts_list',
  description: "List all accounts in Actual Budget including checking, savings, credit cards, and investment accounts. Returns account ID, name, balance, on-budget/off-budget status, and open/closed state.",
  inputSchema: InputSchema,
  call: wrapToolCall(async (_args: unknown, _meta?: unknown) => {
    const result = await getCachedAccounts();
    return { result };
  }),
};

export default tool;
