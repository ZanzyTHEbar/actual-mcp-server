import { z } from 'zod';
import { wrapToolCall } from '../lib/wrapToolCall.js';
import type { paths } from '../../generated/actual-client/types.js';
import type { ToolDefinition } from '../../types/tool.d.js';
import adapter from '../lib/actual-adapter.js';
import { safeGetOrFetch } from '../lib/search/index.js';
import { budgetCacheKey } from '../lib/budgetContext.js';

const InputSchema = z.object({ month: z.string().optional() });

// RESPONSE_TYPE: BudgetMonth
type Output = unknown; // refine using generated types (paths['/budgets/month']['get'])

const tool: ToolDefinition = {
  name: 'actual_budgets_getMonth',
  description: "Get budget data for a specific month in YYYY-MM format (e.g., '2025-12'). Returns all categories with their budgeted amounts, actual spending, and available balances for the month.",
  inputSchema: InputSchema,
  call: wrapToolCall(async (args: unknown, _meta?: unknown) => {
    const input = InputSchema.parse(args || {});
    const monthKey = input.month ?? 'current';
    const result = await safeGetOrFetch(budgetCacheKey(`tool:budgets_getMonth:${monthKey}`), {
      ttlMs: 5 * 60_000,
      tags: ['budgets'],
      fetcher: () => adapter.getBudgetMonth(input.month),
    });
    return { result };
  }),
};

export default tool;
