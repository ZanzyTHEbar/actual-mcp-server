import { z } from 'zod';
import { wrapToolCall } from '../lib/wrapToolCall.js';
import type { ToolDefinition } from '../../types/tool.d.js';
import { getCachedCategoryGroups } from '../lib/cachedRefs.js';

const InputSchema = z.object({});

const tool: ToolDefinition = {
  name: 'actual_category_groups_get',
  description: `List all category groups in Actual Budget. Category groups organize related categories together (e.g., "Monthly Bills" group contains "Rent", "Utilities", "Internet" categories). Each group has an ID, name, and optional properties.`,
  inputSchema: InputSchema,
  call: wrapToolCall(async (_args: unknown, _meta?: unknown) => {
    const groups = await getCachedCategoryGroups();
    return { groups };
  }),
};

export default tool;
