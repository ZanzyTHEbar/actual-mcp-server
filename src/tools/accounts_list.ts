import { z } from 'zod';
import type { paths } from '../../generated/actual-client/types.js';
import type { ToolDefinition } from '../../types/tool.d.js';
import { getAccounts } from '@actual-app/api/methods.js';

const InputSchema = z.object({});

type Output = any; // TODO: refine using paths['/accounts']['get']['responses']['200']

const tool: ToolDefinition = {
  name: 'actual.accounts.list',
  description: "List all accounts",
  inputSchema: InputSchema,
  call: async (_args: any, _meta?: any) => {
    // Call the actual API to list accounts
    const accounts = await getAccounts();
    return { result: accounts };
  },
};

export default tool;
