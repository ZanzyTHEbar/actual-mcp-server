import { z } from 'zod';
import { wrapToolCall } from '../lib/wrapToolCall.js';
import type { ToolDefinition } from '../../types/tool.d.js';
import adapter from '../lib/actual-adapter.js';

const InputSchema = z.object({}).strict();

const tool: ToolDefinition = {
  name: 'actual_schedules_get',
  description:
    'List all schedules in Actual Budget. Schedules automate recurring or one-off transactions and include timing, payee, account, and amount metadata.',
  inputSchema: InputSchema,
  call: wrapToolCall(async (_args: unknown, _meta?: unknown) => {
    const schedules = await adapter.getSchedules();
    return {
      schedules,
      count: Array.isArray(schedules) ? schedules.length : 0,
    };
  }),
};

export default tool;
