import { z } from 'zod';
import { wrapToolCall } from '../lib/wrapToolCall.js';
import type { paths } from '../../generated/actual-client/types.js';
import type { ToolDefinition } from '../../types/tool.d.js';
import adapter from '../lib/actual-adapter.js';
import { safeGetOrFetch } from '../lib/search/index.js';

const InputSchema = z.object({});

// RESPONSE_TYPE: Account[]
type Output = unknown; // refine using generated types (paths['/accounts']['get'])

const tool: ToolDefinition = {
  name: 'actual_accounts_list',
  description: "List all accounts in Actual Budget including checking, savings, credit cards, and investment accounts. Returns account ID, name, balance, on-budget/off-budget status, and open/closed state.",
  inputSchema: InputSchema,
  call: wrapToolCall(async (args: unknown, _meta?: unknown) => {
    const result = await safeGetOrFetch('tool:accounts_list', {
      ttlMs: 10 * 60_000,
      tags: ['accounts'],
      fetcher: () => adapter.getAccounts(),
    });
    return { result };
  }),
};

export default tool;
