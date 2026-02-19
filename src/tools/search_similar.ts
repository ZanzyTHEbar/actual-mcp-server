/**
 * actual_search_similar — given a transaction ID, find the N most similar
 * transactions by vector cosine distance.
 *
 * This enables agents to discover spending patterns, recurring charges,
 * and related transactions without writing complex filters.
 */

import { z } from 'zod';
import { wrapToolCall } from '../lib/wrapToolCall.js';
import type { ToolDefinition } from '../../types/tool.d.js';
import { SearchIndex, createEmbeddingProvider } from '../lib/search/index.js';
import type { EmbeddingProvider } from '../lib/search/index.js';
import { isSearchIndexSynced } from '../lib/search/syncState.js';
import config from '../config.js';
import logger from '../logger.js';

// ---------------------------------------------------------------------------
// Input schema
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Tool definition
// ---------------------------------------------------------------------------

const tool: ToolDefinition = {
  name: 'actual_search_similar',
  description:
    'Find transactions most similar to a given transaction using semantic vector similarity. ' +
    'Useful for discovering spending patterns, recurring charges, and related transactions. ' +
    'Requires the search index to be synced (call actual_hybrid_search first if needed).',
  inputSchema: InputSchema,
  call: wrapToolCall(async (args: unknown, _meta?: unknown) => {
    const input = InputSchema.parse(args || {});

    const dataDir = process.env.SEARCH_INDEX_DIR
      || process.env.MCP_BRIDGE_DATA_DIR
      || config.MCP_BRIDGE_DATA_DIR
      || './actual-data';

    // Open a read-only handle to the search index
    const idx = new SearchIndex(dataDir);
    idx.open();
    const db = idx.getDb();

    if (!isSearchIndexSynced()) {
      idx.close();
      return {
        error: 'Search index not yet synced. Run actual_hybrid_search first to populate the index.',
        results: [],
      };
    }

    // Look up the reference transaction's embedding
    const refRow = db.prepare(
      'SELECT id, payee_name, category_name, account_name, amount, date, notes, embedding FROM transactions WHERE id = ?',
    ).get(input.transactionId) as any;

    if (!refRow) {
      idx.close();
      return {
        error: `Transaction "${input.transactionId}" not found in search index.`,
        results: [],
      };
    }

    if (!refRow.embedding) {
      idx.close();
      return {
        error: `Transaction "${input.transactionId}" has no embedding (vector search unavailable for this row).`,
        results: [],
      };
    }

    // Find similar by cosine distance (brute-force)
    const excludePayeeClause = input.excludeSamePayee
      ? 'AND t.payee_name != ?'
      : '';
    const queryParams: any[] = [refRow.embedding, input.transactionId];
    if (input.excludeSamePayee) queryParams.push(refRow.payee_name);
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
      const rows = db.prepare(sql).all(...queryParams) as any[];

      const results = rows.map((r: any) => ({
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
        similarity: 1 - r.distance, // Convert distance to similarity score [0, 1]
      }));

      idx.close();

      return {
        referenceTransaction: {
          id: refRow.id,
          payee_name: refRow.payee_name,
          category_name: refRow.category_name,
          account_name: refRow.account_name,
          amount: refRow.amount,
          date: refRow.date,
        },
        results,
        totalMatched: results.length,
      };
    } catch (err) {
      idx.close();
      logger.error('[SearchSimilar] Query failed:', err);
      return {
        error: `Vector similarity query failed: ${err instanceof Error ? err.message : err}`,
        results: [],
      };
    }
  }),
};

export default tool;
