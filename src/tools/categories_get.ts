import { z } from 'zod';
import { wrapToolCall } from '../lib/wrapToolCall.js';
import type { ToolDefinition } from '../../types/tool.d.js';
import { getCachedCategories } from '../lib/cachedRefs.js';

const InputSchema = z.object({});

const tool: ToolDefinition = {
  name: 'actual_categories_get',
  description: 'List all budget categories organized by category groups. Categories are spending/income buckets (e.g., Groceries, Rent, Salary) used for budgeting and transaction categorization. Returns both grouped view and flat list with category IDs, names, and group assignments.',
  inputSchema: InputSchema,
  call: wrapToolCall(async (_args: unknown, _meta?: unknown) => {
    const result = await getCachedCategories();
    return { result };
  }),
};

export default tool;
