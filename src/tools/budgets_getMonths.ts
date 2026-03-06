import { z } from 'zod';
import { wrapToolCall } from '../lib/wrapToolCall.js';
import type { paths } from '../../generated/actual-client/types.js';
import type { ToolDefinition } from '../../types/tool.d.js';
import adapter from '../lib/actual-adapter.js';
import { safeGetOrFetch } from '../lib/search/index.js';
import { budgetCacheKey } from '../lib/budgetContext.js';

const InputSchema = z.object({});

// RESPONSE_TYPE: array
type Output = unknown; // refine using generated types (paths['/budgets/months']['get'])

const tool: ToolDefinition = {
  name: 'actual_budgets_getMonths',
  description: "Get a list of all available budget months with summary data. Returns an array of months showing total budgeted, spent, and income for each month. Useful for viewing budget history and trends over time.",
  inputSchema: InputSchema,
  call: wrapToolCall(async (args: unknown, _meta?: unknown) => {
    InputSchema.parse(args || {});
    const result = await safeGetOrFetch(budgetCacheKey('tool:budgets_getMonths'), {
      ttlMs: 5 * 60_000,
      tags: ['budgets'],
      fetcher: () => adapter.getBudgetMonths(),
    });
    return { result };
  }),
};

export default tool;
