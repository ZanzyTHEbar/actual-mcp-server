import { z } from 'zod';
import type { paths } from '../../generated/actual-client/types.js';
import type { ToolDefinition } from '../../types/tool.d.js';
import { addTransactions } from '@actual-app/api/dist/methods.js';

const InputSchema = z.any();

type Output = any; // TODO: refine using paths['/transactions']['post']['responses']['200']

const tool: ToolDefinition = {
  name: 'actual.transactions.create',
  description: "Create a transaction",
  inputSchema: InputSchema,
  call: async (args: any, _meta?: any) => {
    // Call the actual API to create a transaction
    const tx = await addTransactions([args]);
    return { result: tx };
  },
};

export default tool;
