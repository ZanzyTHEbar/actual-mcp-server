import { z } from 'zod';
import { wrapToolCall } from '../lib/wrapToolCall.js';
import type { ToolDefinition } from '../../types/tool.d.js';
import adapter from '../lib/actual-adapter.js';

const InputSchema = z.object({
  startDate: z.string().optional().describe('Start date in YYYY-MM-DD format (default: first day of current month)'),
  endDate: z.string().optional().describe('End date in YYYY-MM-DD format (default: today)'),
  accountId: z.string().optional().describe('Optional: Filter by specific account ID'),
  limit: z.number().optional().default(500).describe('Optional: Maximum number of transactions to return (default: 500)'),
});

type Output = {
  transactions: unknown[];
  summary: { count: number; totalAmount: number };
  dateRange: { startDate: string; endDate: string };
};

const tool: ToolDefinition = {
  name: 'actual_transactions_uncategorized',
  description: 'List uncategorized transactions (category is null). Useful for cleanup workflows and rule suggestions. Defaults to current month unless a date range is provided.',
  inputSchema: InputSchema,
  call: wrapToolCall(async (args: unknown, _meta?: unknown) => {
    const input = InputSchema.parse(args || {});

    const today = new Date();
    const firstDayOfMonth = new Date(today.getFullYear(), today.getMonth(), 1);
    const startDate = input.startDate || firstDayOfMonth.toISOString().split('T')[0];
    const endDate = input.endDate || today.toISOString().split('T')[0];
    const accountId = input.accountId ?? undefined;

    const transactions = await adapter.getTransactions(accountId, startDate, endDate);
    const txns = Array.isArray(transactions) ? transactions : [];
    const uncategorized = txns.filter((txn: any) => txn?.category == null);
    const limited = uncategorized.slice(0, input.limit || 500);

    const totalAmount = limited.reduce((sum: number, txn: any) => {
      const amount = typeof txn?.amount === 'number' ? txn.amount : 0;
      return sum + amount;
    }, 0);

    const result: Output = {
      transactions: limited,
      summary: {
        count: limited.length,
        totalAmount,
      },
      dateRange: {
        startDate,
        endDate,
      },
    };

    return { result };
  }),
};

export default tool;
