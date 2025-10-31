import { z } from 'zod';
import type { paths } from '../../generated/actual-client/types.js';
import type { ToolDefinition } from '../../types/tool.d.js';
import adapter from '../lib/actual-adapter.js';

const InputSchema = z.object({});

// RESPONSE_TYPE: Account[]
type Output = any; // refine using generated types (paths['/accounts']['get'])

const tool: ToolDefinition = {
  name: 'actual.accounts.list',
  description: "List all accounts",
  inputSchema: InputSchema,
  call: async (args: any, _meta?: any) => {
    // validate input
    const input = InputSchema.parse(args || {});
    // call adapter.getAccounts (wrap args as appropriate)
    const result = await adapter.getAccounts(input);
    return { result };

  },
};

export default tool;
