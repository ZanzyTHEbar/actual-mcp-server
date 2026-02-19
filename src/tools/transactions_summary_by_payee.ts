import { z } from 'zod';
import { wrapToolCall } from '../lib/wrapToolCall.js';
import type { ToolDefinition } from '../../types/tool.d.js';
import adapter from '../lib/actual-adapter.js';
import { getCachedPayees } from '../lib/cachedRefs.js';

const InputSchema = z.object({
  startDate: z.string().optional().describe('Start date in YYYY-MM-DD format (default: first day of current month)'),
  endDate: z.string().optional().describe('End date in YYYY-MM-DD format (default: today)'),
  accountId: z.string().optional().describe('Optional: Filter by specific account ID'),
  limit: z.number().optional().default(50).describe('Optional: Maximum number of payees to return (default: 50, ordered by totalAmount descending)'),
});

type Output = {
  summary: Array<{
    payeeName: string;
    totalAmount: number;
    transactionCount: number;
  }>;
  totalAmount: number;
  dateRange: {
    startDate: string;
    endDate: string;
  };
};

const tool: ToolDefinition = {
  name: 'actual_transactions_summary_by_payee',
  description: 'Get spending summary grouped by payee from transaction data. Returns total amount and transaction count per payee for a date range. Useful for identifying top vendors and analyzing merchant spending patterns. Results are ordered by total amount (highest first).',
  inputSchema: InputSchema,
  call: wrapToolCall(async (args: unknown, _meta?: unknown) => {
    const input = InputSchema.parse(args || {});

    // Default to current month if dates not provided
    const today = new Date();
    const firstDayOfMonth = new Date(today.getFullYear(), today.getMonth(), 1);
    const startDate = input.startDate || firstDayOfMonth.toISOString().split('T')[0];
    const endDate = input.endDate || today.toISOString().split('T')[0];

    const accountId = input.accountId ?? undefined;

    // Transactions not cached (unique per date/account); payees cached
    const [transactions, payees] = await Promise.all([
      adapter.getTransactions(accountId, startDate, endDate),
      getCachedPayees(),
    ]);

    const payeeById = new Map<string, any>();
    for (const payee of payees as any[]) {
      if (payee?.id) payeeById.set(payee.id, payee);
    }

    const summaryMap = new Map<string, { payeeName: string; totalAmount: number; transactionCount: number }>();
    const txns = Array.isArray(transactions) ? transactions : [];

    for (const txn of txns as any[]) {
      const amount = typeof txn?.amount === 'number' ? txn.amount : 0;
      const payeeId = txn?.payee ?? null;

      const payeeName = payeeId ? (payeeById.get(payeeId)?.name || 'Unknown') : 'Unknown';
      const key = payeeId || 'unknown';
      const entry = summaryMap.get(key) || { payeeName, totalAmount: 0, transactionCount: 0 };
      entry.totalAmount += amount;
      entry.transactionCount += 1;
      summaryMap.set(key, entry);
    }

    const summary = Array.from(summaryMap.values())
      .sort((a, b) => b.totalAmount - a.totalAmount)
      .slice(0, input.limit || 50);

    // Calculate grand total
    const totalAmount = summary.reduce((sum, item) => sum + item.totalAmount, 0);

    return {
      summary,
      totalAmount,
      dateRange: {
        startDate,
        endDate,
      },
    };
  }),
};

export default tool;
