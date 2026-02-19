import { z } from 'zod';
import { wrapToolCall } from '../lib/wrapToolCall.js';
import type { paths } from '../../generated/actual-client/types.js';
import type { ToolDefinition } from '../../types/tool.d.js';
import adapter from '../lib/actual-adapter.js';
import { safeGetOrFetch } from '../lib/search/index.js';

const InputSchema = z.object({});

// RESPONSE_TYPE: Category[]
type Output = unknown; // refine using generated types (paths['/categories']['get'])

const tool: ToolDefinition = {
  name: 'actual_categories_get',
  description: 'List all budget categories organized by category groups. Categories are spending/income buckets (e.g., Groceries, Rent, Salary) used for budgeting and transaction categorization. Returns both grouped view and flat list with category IDs, names, and group assignments.',
  inputSchema: InputSchema,
  call: wrapToolCall(async (args: unknown, _meta?: unknown) => {
    InputSchema.parse(args || {});
    const result = await safeGetOrFetch('tool:categories_get', {
      ttlMs: 10 * 60_000,
      tags: ['categories'],
      fetcher: () => adapter.getCategories(),
    });
    return { result };
  }),
};

export default tool;
