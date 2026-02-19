import { z } from 'zod';
import { wrapToolCall } from '../lib/wrapToolCall.js';
import type { ToolDefinition } from '../../types/tool.d.js';
import adapter from '../lib/actual-adapter.js';
import { getCachedCategories, getCachedCategoryGroups } from '../lib/cachedRefs.js';

const InputSchema = z.object({
  startDate: z.string().optional().describe('Start date in YYYY-MM-DD format (default: first day of current month)'),
  endDate: z.string().optional().describe('End date in YYYY-MM-DD format (default: today)'),
  accountId: z.string().optional().describe('Optional: Filter by specific account ID'),
  includeIncome: z.boolean().optional().default(false).describe('Optional: Include income categories (default: false, only expenses)'),
});

type Output = {
  summary: Array<{
    categoryGroup: string;
    categoryName: string;
    totalAmount: number;
    transactionCount?: number;
  }>;
  totalAmount: number;
  dateRange: {
    startDate: string;
    endDate: string;
  };
};

const tool: ToolDefinition = {
  name: 'actual_transactions_summary_by_category',
  description: 'Get spending summary grouped by category from transaction data. Returns total amount and transaction count per category for a date range. Perfect for budget analysis and expense tracking. By default excludes income categories (set includeIncome=true to include them).',
  inputSchema: InputSchema,
  call: wrapToolCall(async (args: unknown, _meta?: unknown) => {
    const input = InputSchema.parse(args || {});

    // Default to current month if dates not provided
    const today = new Date();
    const firstDayOfMonth = new Date(today.getFullYear(), today.getMonth(), 1);
    const startDate = input.startDate || firstDayOfMonth.toISOString().split('T')[0];
    const endDate = input.endDate || today.toISOString().split('T')[0];

    const accountId = input.accountId ?? undefined;

    // Transactions are not cached (unique per date/account); ref data is cached
    const [transactions, categories, categoryGroups] = await Promise.all([
      adapter.getTransactions(accountId, startDate, endDate),
      getCachedCategories(),
      getCachedCategoryGroups(),
    ]);

    const categoryById = new Map<string, any>();
    for (const category of categories as any[]) {
      if (category?.id) categoryById.set(category.id, category);
    }

    const groupById = new Map<string, any>();
    for (const group of categoryGroups as any[]) {
      if (group?.id) groupById.set(group.id, group);
    }

    const summaryMap = new Map<string, {
      categoryGroup: string;
      categoryName: string;
      totalAmount: number;
      transactionCount: number;
      groupSort: number;
      categorySort: number;
    }>();

    const txns = Array.isArray(transactions) ? transactions : [];
    for (const txn of txns as any[]) {
      const amount = typeof txn?.amount === 'number' ? txn.amount : 0;
      const categoryId = txn?.category ?? null;

      if (categoryId) {
        const category = categoryById.get(categoryId);
        const group = category ? groupById.get(category.group) : undefined;
        const isIncome = Boolean(category?.is_income ?? group?.is_income);

        if (!input.includeIncome && isIncome) continue;

        const groupName = group?.name || 'Uncategorized';
        const categoryName = category?.name || 'Uncategorized';
        const key = `${group?.id || 'uncategorized'}:${categoryId}`;

        const entry = summaryMap.get(key) || {
          categoryGroup: groupName,
          categoryName,
          totalAmount: 0,
          transactionCount: 0,
          groupSort: typeof group?.sort_order === 'number' ? group.sort_order : Number.MAX_SAFE_INTEGER,
          categorySort: typeof category?.sort_order === 'number' ? category.sort_order : Number.MAX_SAFE_INTEGER,
        };

        entry.totalAmount += amount;
        entry.transactionCount += 1;
        summaryMap.set(key, entry);
      } else {
        const key = 'uncategorized:uncategorized';
        const entry = summaryMap.get(key) || {
          categoryGroup: 'Uncategorized',
          categoryName: 'Uncategorized',
          totalAmount: 0,
          transactionCount: 0,
          groupSort: Number.MAX_SAFE_INTEGER,
          categorySort: Number.MAX_SAFE_INTEGER,
        };

        entry.totalAmount += amount;
        entry.transactionCount += 1;
        summaryMap.set(key, entry);
      }
    }

    const summary = Array.from(summaryMap.values()).sort((a, b) => {
      if (a.groupSort !== b.groupSort) return a.groupSort - b.groupSort;
      if (a.categorySort !== b.categorySort) return a.categorySort - b.categorySort;
      return a.categoryName.localeCompare(b.categoryName);
    }).map(({ groupSort, categorySort, ...rest }) => rest);

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
