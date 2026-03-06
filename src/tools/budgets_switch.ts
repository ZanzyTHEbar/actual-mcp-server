import { z } from 'zod';
import { wrapToolCall } from '../lib/wrapToolCall.js';
import type { ToolDefinition } from '../../types/tool.d.js';
import { sessionWorkerManager } from '../lib/SessionWorkerManager.js';
import { requestContext } from '../lib/requestContext.js';
import { toErrorResult } from '../lib/toolResult.js';

const InputSchema = z.object({
  budgetName: z.string().min(1, 'budgetName must not be empty'),
});

const tool: ToolDefinition = {
  name: 'actual_budgets_switch',
  description:
    'Switch the active budget for the current session. This only affects the current MCP session and does not change other sessions.',
  inputSchema: InputSchema,
  call: wrapToolCall(async (args: unknown, _meta?: unknown) => {
    const input = InputSchema.parse(args || {});
    const context = requestContext.getStore();
    const sessionId = context?.sessionId;

    if (!sessionId) {
      return toErrorResult({ message: 'Budget switching requires an active session context.' });
    }

    try {
      return sessionWorkerManager.getBudgetSwitchResult(sessionId, input.budgetName, context?.identity);
    } catch (err) {
      return toErrorResult({
        message: err instanceof Error ? err.message : String(err),
      });
    }
  }),
};

export default tool;
