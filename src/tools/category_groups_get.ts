import { z } from 'zod';
import { wrapToolCall } from '../lib/wrapToolCall.js';
import type { ToolDefinition } from '../../types/tool.d.js';
import adapter from '../lib/actual-adapter.js';
import { safeGetOrFetch } from '../lib/search/index.js';

const InputSchema = z.object({});

const tool: ToolDefinition = {
  name: 'actual_category_groups_get',
  description: `List all category groups in Actual Budget. Category groups organize related categories together (e.g., "Monthly Bills" group contains "Rent", "Utilities", "Internet" categories). Each group has an ID, name, and optional properties.`,
  inputSchema: InputSchema,
  call: wrapToolCall(async (args: unknown, _meta?: unknown) => {
    const groups = await safeGetOrFetch('tool:category_groups_get', {
      ttlMs: 10 * 60_000,
      tags: ['category_groups'],
      fetcher: () => adapter.getCategoryGroups(),
    });
    return { groups };
  }),
};

export default tool;
