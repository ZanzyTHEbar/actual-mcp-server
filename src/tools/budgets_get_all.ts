import { z } from 'zod';
import { wrapToolCall } from '../lib/wrapToolCall.js';
import type { ToolDefinition } from '../../types/tool.d.js';
import adapter from '../lib/actual-adapter.js';
import { safeGetOrFetch } from '../lib/search/index.js';

const InputSchema = z.object({});

type Output = unknown;

const tool: ToolDefinition = {
  name: 'actual_budgets_get_all',
  description: 'Get a list of all available budget files. Useful for multi-budget management and discovering available budgets on the server.',
  inputSchema: InputSchema,
  call: wrapToolCall(async (_args: unknown, _meta?: unknown) => {
    const result = await safeGetOrFetch('tool:budgets_get_all', {
      ttlMs: 5 * 60_000,
      tags: ['budgets'],
      fetcher: () => adapter.getBudgets(),
    });
    return { result };
  }),
};

export default tool;
