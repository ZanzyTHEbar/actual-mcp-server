import { z } from 'zod';
import { wrapToolCall } from '../lib/wrapToolCall.js';
import type { ToolDefinition } from '../../types/tool.d.js';
import adapter from '../lib/actual-adapter.js';

const FieldsSchema = z.object({
  account: z.string().nullable().optional().describe('Account ID'),
  date: z.string().nullable().optional().describe('Transaction date (YYYY-MM-DD)'),
  amount: z.number().nullable().optional().describe('Amount in cents (e.g., 1000 = $10.00)'),
  payee: z.string().nullable().optional().describe('Payee ID'),
  payee_name: z.string().nullable().optional().describe('Payee name'),
  imported_payee: z.string().nullable().optional().describe('Original imported payee name'),
  category: z.string().nullable().optional().describe('Category ID'),
  notes: z.string().nullable().optional().describe('Transaction notes'),
  cleared: z.boolean().nullable().optional().describe('Whether transaction is cleared'),
});

const UpdateItemSchema = z.object({
  id: z.string().describe('Transaction ID to update'),
  fields: FieldsSchema.describe('Fields to update for this transaction'),
});

const InputSchema = z.object({
  updates: z.array(UpdateItemSchema)
    .min(1)
    .max(100)
    .describe('Array of {id, fields} objects. Max 100 per batch.'),
});

type BatchResult = {
  succeeded: { id: string }[];
  failed: { id: string; error: string }[];
  total: number;
  successCount: number;
  failureCount: number;
};

const tool: ToolDefinition = {
  name: 'actual_transactions_update_batch',
  description: `Update multiple transactions in a single call. Accepts up to 100 {id, fields} pairs. Each update is applied independently — partial failures are reported per-item so you know exactly which succeeded and which failed.

Returns: { succeeded: [{id}], failed: [{id, error}], total, successCount, failureCount }

Example: { updates: [{ id: "txn-uuid-1", fields: { category: "cat-uuid" } }, { id: "txn-uuid-2", fields: { notes: "Reimbursement" } }] }`,
  inputSchema: InputSchema,
  call: wrapToolCall(async (args: unknown, _meta?: unknown) => {
    const input = InputSchema.parse(args || {});

    const succeeded: { id: string }[] = [];
    const failed: { id: string; error: string }[] = [];

    // Process updates sequentially to avoid overwhelming the adapter
    // and to get clean error isolation per item
    for (const item of input.updates) {
      try {
        await adapter.updateTransaction(item.id, item.fields);
        succeeded.push({ id: item.id });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        failed.push({ id: item.id, error: message });
      }
    }

    const result: BatchResult = {
      succeeded,
      failed,
      total: input.updates.length,
      successCount: succeeded.length,
      failureCount: failed.length,
    };

    return result;
  }),
};

export default tool;
