/**
 * actual_search_similar — given a transaction ID, find the N most similar
 * transactions by vector cosine distance.
 *
 * Uses the shared search runtime singleton instead of creating throwaway instances.
 */

import { z } from 'zod';
import { wrapToolCall } from '../lib/wrapToolCall.js';
import type { ToolDefinition } from '../../types/tool.d.js';
import { getSearchRuntime } from '../lib/search/index.js';
import { isSearchIndexSynced } from '../lib/search/syncState.js';
import type { DatabaseInstance } from '../lib/search/types.js';
import { toErrorResult } from '../lib/toolResult.js';
import logger from '../logger.js';

interface RefRow {
  id: string;
  payee_name: string | null;
  category_name: string | null;
  account_name: string | null;
  amount: number;
  date: string;
  notes: string | null;
  embedding: Uint8Array | null;
}

interface SimilarRow {
  id: string;
  date: string;
  amount: number;
  notes: string | null;
  payee_name: string | null;
  category_name: string | null;
  account_name: string | null;
  is_transfer: number;
  cleared: number;
  distance: number;
}

const InputSchema = z.object({
  transactionId: z
    .string()
    .describe('UUID of the reference transaction to find similar matches for'),
  limit: z
    .number()
    .optional()
    .default(10)
    .describe('Max number of similar transactions to return (default 10)'),
  excludeSamePayee: z
    .boolean()
    .optional()
    .default(false)
    .describe('If true, exclude transactions with the same payee'),
});

const tool: ToolDefinition = {
  name: 'actual_search_similar',
  description:
    'Find transactions most similar to a given transaction using semantic vector similarity. ' +
    'Useful for discovering spending patterns, recurring charges, and related transactions. ' +
    'Requires the search index to be synced (call actual_hybrid_search first if needed).',
  inputSchema: InputSchema,
  call: wrapToolCall(async (args: unknown, _meta?: unknown) => {
    const input = InputSchema.parse(args || {});

    let db: DatabaseInstance;
    try {
      const { index } = await getSearchRuntime();
      db = index.getDb();
    } catch (err) {
      logger.error('[SearchSimilar] Failed to get search runtime:', err);
      return toErrorResult({ message: 'Search engine not available.' });
    }

    if (!isSearchIndexSynced()) {
      return toErrorResult({
        message: 'Search index not yet synced. Run actual_hybrid_search first to populate the index.',
      });
    }

    const refRow = db.prepare(
      'SELECT id, payee_name, category_name, account_name, amount, date, notes, embedding FROM transactions WHERE id = ?',
    ).get(input.transactionId) as RefRow | undefined;

    if (!refRow) {
      return toErrorResult({ message: `Transaction "${input.transactionId}" not found in search index.` });
    }

    if (!refRow.embedding) {
      return toErrorResult({ message: `Transaction "${input.transactionId}" has no embedding.` });
    }

    const excludePayeeClause = input.excludeSamePayee ? 'AND t.payee_name != ?' : '';
    const queryParams: (Uint8Array | string | number)[] = [refRow.embedding, input.transactionId];
    if (input.excludeSamePayee) queryParams.push(refRow.payee_name ?? '');
    queryParams.push(input.limit);

    const sql = `
      SELECT
        t.id, t.date, t.amount, t.notes,
        t.payee_name, t.category_name, t.account_name,
        t.is_transfer, t.cleared,
        vector_distance_cos(t.embedding, ?) AS distance
      FROM transactions t
      WHERE t.id != ?
        AND t.embedding IS NOT NULL
        ${excludePayeeClause}
      ORDER BY distance ASC
      LIMIT ?
    `;

    try {
      const rows = db.prepare(sql).all(...queryParams) as SimilarRow[];

      return {
        referenceTransaction: {
          id: refRow.id,
          payee_name: refRow.payee_name,
          category_name: refRow.category_name,
          account_name: refRow.account_name,
          amount: refRow.amount,
          date: refRow.date,
        },
        results: rows.map((r) => ({
          id: r.id,
          date: r.date,
          amount: r.amount,
          amount_display: `$${(Math.abs(r.amount) / 100).toFixed(2)}`,
          type: r.amount < 0 ? 'expense' : 'income',
          notes: r.notes,
          payee_name: r.payee_name,
          category_name: r.category_name,
          account_name: r.account_name,
          is_transfer: Boolean(r.is_transfer),
          cleared: Boolean(r.cleared),
          similarity: 1 - r.distance,
        })),
        totalMatched: rows.length,
      };
    } catch (err) {
      logger.error('[SearchSimilar] Query failed:', err);
      return toErrorResult({
        message: `Vector similarity query failed: ${err instanceof Error ? err.message : err}`,
      });
    }
  }),
};

export default tool;
