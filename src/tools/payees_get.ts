import { z } from 'zod';
import { wrapToolCall } from '../lib/wrapToolCall.js';
import type { paths } from '../../generated/actual-client/types.js';
import type { ToolDefinition } from '../../types/tool.d.js';
import adapter from '../lib/actual-adapter.js';
import { safeGetOrFetch } from '../lib/search/index.js';

const InputSchema = z.object({});

// RESPONSE_TYPE: Payee[]
type Output = unknown; // refine using generated types (paths['/payees']['get'])

const tool: ToolDefinition = {
  name: 'actual_payees_get',
  description: "List all payees in Actual Budget. Payees represent merchants, service providers, individuals, or other entities you transact with. Returns payee ID, name, and optional transfer account information for internal transfers.",
  inputSchema: InputSchema,
  call: wrapToolCall(async (args: unknown, _meta?: unknown) => {
    InputSchema.parse(args || {});
    const result = await safeGetOrFetch('tool:payees_get', {
      ttlMs: 10 * 60_000,
      tags: ['payees'],
      fetcher: () => adapter.getPayees(),
    });
    return { result };
  }),
};

export default tool;
