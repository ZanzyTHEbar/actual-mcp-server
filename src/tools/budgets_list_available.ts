import { z } from 'zod';
import { wrapToolCall } from '../lib/wrapToolCall.js';
import type { ToolDefinition } from '../../types/tool.d.js';
import { sessionWorkerManager } from '../lib/SessionWorkerManager.js';
import { requestContext } from '../lib/requestContext.js';

const InputSchema = z.object({}).strict();

const tool: ToolDefinition = {
  name: 'actual_budgets_list_available',
  description:
    'List all configured budgets available for switching in this MCP server, filtered by the current user ACL when authentication is enabled.',
  inputSchema: InputSchema,
  call: wrapToolCall(async (_args: unknown, _meta?: unknown) => {
    const context = requestContext.getStore();
    return sessionWorkerManager.getBudgetListResult(context?.identity, context?.sessionId);
  }),
};

export default tool;
