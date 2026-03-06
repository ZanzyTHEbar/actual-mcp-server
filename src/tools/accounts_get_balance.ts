import { z } from 'zod';
import { wrapToolCall } from '../lib/wrapToolCall.js';
import type { paths } from '../../generated/actual-client/types.js';
import type { ToolDefinition } from '../../types/tool.d.js';
import adapter from '../lib/actual-adapter.js';
import { safeGetOrFetch } from '../lib/search/index.js';
import { budgetCacheKey } from '../lib/budgetContext.js';

const InputSchema = z.object({
  id: z.string().min(1, 'Account ID is required').describe('The UUID of the account'),
  cutoff: z.string().optional().describe('Optional cutoff date (YYYY-MM-DD format)')
}).strict();

// RESPONSE_TYPE: number
type Output = unknown; // refine using generated types (paths['/accounts/balance']['get'])

const tool: ToolDefinition = {
  name: 'actual_accounts_get_balance',
  description: `Get the current balance of a specific account.

Required:
- id: Account UUID

Optional:
- cutoff: Date to calculate balance up to (YYYY-MM-DD format)

Returns the account balance as a number (in cents).

Example:
{
  "id": "791f738b-847b-48cc-b32b-bbcf2bc8314f"
}`,
  inputSchema: InputSchema,
  call: wrapToolCall(async (args: unknown, _meta?: unknown) => {
    try {
      const input = InputSchema.parse(args || {});
      const cutoffKey = input.cutoff ?? 'current';
      const balance = await safeGetOrFetch(budgetCacheKey(`tool:balance:${input.id}:${cutoffKey}`), {
        ttlMs: 2 * 60_000, // 2min — balances change frequently
        tags: ['accounts', 'transactions'],
        fetcher: () => adapter.getAccountBalance(input.id, input.cutoff),
      });
      return { balance };
    } catch (error) {
      const err = error as Error;
      if (err.message?.includes('fetch failed') || err.message?.includes('not found')) {
        throw new Error(`Account not found. Please call actual_accounts_list first to get valid account IDs. Error: ${err.message}`);
      }
      throw error;
    }
  }),
};

export default tool;
