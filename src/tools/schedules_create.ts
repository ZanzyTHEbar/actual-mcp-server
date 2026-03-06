import { z } from 'zod';
import { wrapToolCall } from '../lib/wrapToolCall.js';
import type { ToolDefinition } from '../../types/tool.d.js';
import adapter from '../lib/actual-adapter.js';
import { UUID_PATTERN } from '../lib/constants.js';

const AmountBetweenSchema = z.object({
  num1: z.number().int(),
  num2: z.number().int(),
});

const AmountSchema = z.union([z.number().int(), AmountBetweenSchema]);

const RecurConfigSchema = z.object({
  frequency: z.enum(['daily', 'weekly', 'monthly', 'yearly']),
  start: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  endMode: z.enum(['never', 'after_n_occurrences', 'on_date']),
  interval: z.number().int().positive().optional(),
  skipWeekend: z.boolean().optional(),
  weekendSolveMode: z.enum(['before', 'after']).optional(),
  endOccurrences: z.number().int().positive().optional(),
  endDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
});

const InputSchema = z.object({
  name: z.string().optional().describe('Unique display name for the schedule'),
  payee: z.string().regex(UUID_PATTERN, 'Invalid UUID format').optional(),
  account: z.string().regex(UUID_PATTERN, 'Invalid UUID format').optional(),
  amount: AmountSchema.optional().describe('Amount in cents, or { num1, num2 } when amountOp is "isbetween"'),
  amountOp: z.enum(['is', 'isapprox', 'isbetween']).optional().default('is'),
  date: z.union([
    z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    RecurConfigSchema,
  ]).describe('Date string for one-off schedules, or a recurrence config object for recurring schedules'),
  posts_transaction: z.boolean().optional().default(false),
});

function validateAmountOperator(
  amount: z.infer<typeof AmountSchema> | undefined,
  amountOp: z.infer<typeof InputSchema>['amountOp'],
): void {
  const isRangeAmount = typeof amount === 'object' && amount !== null;
  if (amountOp === 'isbetween' && !isRangeAmount) {
    throw new Error('amountOp "isbetween" requires amount to be an object with num1 and num2');
  }
  if (amountOp !== 'isbetween' && isRangeAmount) {
    throw new Error('Range amount objects are only valid when amountOp is "isbetween"');
  }
}

const tool: ToolDefinition = {
  name: 'actual_schedules_create',
  description:
    'Create a new schedule in Actual Budget. Supports one-off schedules with a YYYY-MM-DD date or recurring schedules with a recurrence config object.',
  inputSchema: InputSchema,
  call: wrapToolCall(async (args: unknown, _meta?: unknown) => {
    const input = InputSchema.parse(args || {});
    validateAmountOperator(input.amount, input.amountOp);

    const id = await adapter.createSchedule(input);
    return { id };
  }),
};

export default tool;
