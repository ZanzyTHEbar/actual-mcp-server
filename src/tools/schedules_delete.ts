import { z } from 'zod';
import { wrapToolCall } from '../lib/wrapToolCall.js';
import type { ToolDefinition } from '../../types/tool.d.js';
import adapter from '../lib/actual-adapter.js';
import { UUID_PATTERN } from '../lib/constants.js';
import { notFoundMsg, constraintErrorMsg } from '../lib/errors.js';
import { toErrorResult } from '../lib/toolResult.js';

const InputSchema = z.object({
  id: z.string().regex(UUID_PATTERN, 'Invalid UUID format'),
});

const tool: ToolDefinition = {
  name: 'actual_schedules_delete',
  description:
    'Permanently delete a schedule from Actual Budget. This also removes the underlying schedule rule.',
  inputSchema: InputSchema,
  call: wrapToolCall(async (args: unknown, _meta?: unknown) => {
    const input = InputSchema.parse(args || {});
    const schedules = await adapter.getSchedules();
    const scheduleExists = Array.isArray(schedules)
      && schedules.some((schedule: any) => schedule?.id === input.id);

    if (!scheduleExists) {
      return toErrorResult({
        message: notFoundMsg('Schedule', input.id, 'actual_schedules_get'),
      });
    }

    try {
      await adapter.deleteSchedule(input.id);
      return { success: true };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (message.includes('NOT NULL constraint') || message.includes('messages_crdt')) {
        return toErrorResult({
          message: constraintErrorMsg('Schedule', input.id, 'actual_schedules_get'),
        });
      }
      throw err;
    }
  }),
};

export default tool;
