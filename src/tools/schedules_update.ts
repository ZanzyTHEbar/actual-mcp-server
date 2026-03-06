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

const RecurConfigSchema = z.object({}).passthrough();

const InputSchema = z.object({
  id: z.string().regex(UUID_PATTERN, 'Invalid UUID format'),
  name: z.string().optional(),
  payee: z.string().regex(UUID_PATTERN, 'Invalid UUID format').nullable().optional(),
  account: z.string().regex(UUID_PATTERN, 'Invalid UUID format').nullable().optional(),
  amount: AmountSchema.optional(),
  amountOp: z.enum(['is', 'isapprox', 'isbetween']).optional(),
  date: z.union([
    z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    RecurConfigSchema,
  ]).optional(),
  posts_transaction: z.boolean().optional(),
  completed: z.boolean().optional(),
  resetNextDate: z.boolean().optional().default(false),
});

function validateAmountOperator(
  amount: z.infer<typeof AmountSchema> | undefined,
  amountOp: z.infer<typeof InputSchema>['amountOp'],
): void {
  if (amount === undefined || amountOp === undefined) return;

  const isRangeAmount = typeof amount === 'object' && amount !== null;
  if (amountOp === 'isbetween' && !isRangeAmount) {
    throw new Error('amountOp "isbetween" requires amount to be an object with num1 and num2');
  }
  if (amountOp !== 'isbetween' && isRangeAmount) {
    throw new Error('Range amount objects are only valid when amountOp is "isbetween"');
  }
}

const tool: ToolDefinition = {
  name: 'actual_schedules_update',
  description:
    'Update an existing schedule in Actual Budget. Set resetNextDate to true when changing the date or recurrence configuration.',
  inputSchema: InputSchema,
  call: wrapToolCall(async (args: unknown, _meta?: unknown) => {
    const input = InputSchema.parse(args || {});
    validateAmountOperator(input.amount, input.amountOp);

    const { id, resetNextDate, ...fields } = input;
    await adapter.updateSchedule(id, fields, resetNextDate ?? false);
    return { success: true };
  }),
};

export default tool;
