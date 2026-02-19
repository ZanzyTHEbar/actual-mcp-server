import { z } from 'zod';
import { wrapToolCall } from '../lib/wrapToolCall.js';
import type { ToolDefinition } from '../../types/tool.d.js';
import adapter from '../lib/actual-adapter.js';
import { safeGetOrFetch } from '../lib/search/index.js';

const InputSchema = z.object({
  payeeId: z.string().describe('ID of the payee to get rules for'),
});

const tool: ToolDefinition = {
  name: 'actual_payee_rules_get',
  description: `Get all payee rules associated with a specific payee. Returns PayeeRule objects that show how transactions with this payee are automatically processed (conditions and actions).`,
  inputSchema: InputSchema,
  call: wrapToolCall(async (args: unknown, _meta?: unknown) => {
    const input = InputSchema.parse(args || {});
    const rules = await safeGetOrFetch(`tool:payee_rules:${input.payeeId}`, {
      ttlMs: 10 * 60_000,
      tags: ['rules'],
      fetcher: () => adapter.getPayeeRules(input.payeeId),
    });
    return { rules, count: rules.length };
  }),
};

export default tool;
