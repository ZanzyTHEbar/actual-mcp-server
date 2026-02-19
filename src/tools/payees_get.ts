import { z } from 'zod';
import { wrapToolCall } from '../lib/wrapToolCall.js';
import type { ToolDefinition } from '../../types/tool.d.js';
import { getCachedPayees } from '../lib/cachedRefs.js';

const InputSchema = z.object({});

const tool: ToolDefinition = {
  name: 'actual_payees_get',
  description: "List all payees in Actual Budget. Payees represent merchants, service providers, individuals, or other entities you transact with. Returns payee ID, name, and optional transfer account information for internal transfers.",
  inputSchema: InputSchema,
  call: wrapToolCall(async (_args: unknown, _meta?: unknown) => {
    const result = await getCachedPayees();
    return { result };
  }),
};

export default tool;
