import { z } from 'zod';
import { wrapToolCall } from '../lib/wrapToolCall.js';
import type { ToolDefinition } from '../../types/tool.d.js';
import adapter from '../lib/actual-adapter.js';
import { safeGetOrFetch } from '../lib/search/index.js';

const InputSchema = z.object({});

const tool: ToolDefinition = {
  name: 'actual_rules_get',
  description: `List all budget rules in Actual Budget. Rules automate transaction categorization and other budget operations based on conditions. Each rule has conditions (e.g., payee matches "Amazon") and actions (e.g., set category to "Shopping").`,
  inputSchema: InputSchema,
  call: wrapToolCall(async (args: unknown, _meta?: unknown) => {
    const rules = await safeGetOrFetch('tool:rules_get', {
      ttlMs: 10 * 60_000,
      tags: ['rules'],
      fetcher: () => adapter.getRules(),
    });
    return { rules };
  }),
};

export default tool;
