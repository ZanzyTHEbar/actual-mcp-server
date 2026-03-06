/**
 * actual_hybrid_search — MCP tool that exposes the hybrid search engine
 * (BM25 + vector + metadata + RRF) to MCP clients.
 *
 * This is the primary "agentic search" tool.  An LLM agent can issue a
 * natural-language query like "coffee shops last month" and get ranked
 * results combining exact keyword matches, semantic similarity, and
 * structured metadata filters.
 */

import { z } from 'zod';
import { wrapToolCall } from '../lib/wrapToolCall.js';
import type { ToolDefinition } from '../../types/tool.d.js';
import adapter from '../lib/actual-adapter.js';
import {
  SearchIndex,
  HybridSearchEngine,
  getResponseCache,
  getSearchRuntime,
} from '../lib/search/index.js';
import type { EmbeddingProvider } from '../lib/search/index.js';
import {
  hydrateSearchSyncState,
  isSearchIndexSynced,
  markSearchIndexSyncedIfGeneration,
} from '../lib/search/syncState.js';
import type {
  IndexedTransaction,
  RefAccount,
  RefCategory,
  RefPayee,
  HybridSearchQuery,
  SearchResponse,
} from '../lib/search/index.js';
import { toErrorResult } from '../lib/toolResult.js';
import logger from '../logger.js';
import { budgetCacheKey, getCurrentBudgetKey } from '../lib/budgetContext.js';

/**
 * The Actual Budget `getTransactions()` API returns richer data than the
 * generated OpenAPI types suggest. This interface captures the real runtime
 * shape so we can map to IndexedTransaction without `any` casts.
 */
interface ActualRawTransaction {
  id?: string;
  date?: string;
  amount?: number;
  notes?: string;
  payee?: string;
  category?: string;
  account?: string;
  transfer_id?: string;
  cleared?: boolean | number;
  [key: string]: unknown;
}

// ---------------------------------------------------------------------------
// Input schema
// ---------------------------------------------------------------------------

const InputSchema = z.object({
  query: z
    .string()
    .optional()
    .describe(
      'Natural-language search query (e.g. "groceries last month", "Amazon", "rent payments"). ' +
      'Used for both keyword (BM25) and semantic (vector) matching.',
    ),
  accountId: z.string().optional().describe('Filter by account UUID'),
  categoryId: z.string().optional().describe('Filter by category UUID'),
  payeeId: z.string().optional().describe('Filter by payee UUID'),
  startDate: z.string().optional().describe('Filter: start date (YYYY-MM-DD)'),
  endDate: z.string().optional().describe('Filter: end date (YYYY-MM-DD)'),
  minAmount: z.number().optional().describe('Filter: minimum amount in cents'),
  maxAmount: z.number().optional().describe('Filter: maximum amount in cents'),
  limit: z.number().optional().default(25).describe('Max results (default 25)'),
  mode: z
    .enum(['hybrid', 'fulltext', 'vector', 'metadata'])
    .optional()
    .default('hybrid')
    .describe(
      'Search mode: hybrid (FTS5 + vector + RRF), fulltext (BM25 only), ' +
      'vector (semantic only), or metadata (filters only).',
    ),
});

// No local singletons — use shared search runtime from searchRuntime.ts
const _syncInFlight = new Map<string, Promise<void>>();

/**
 * Sync the search index from Actual Budget data.
 * Called lazily on first search, then cached until invalidation.
 */
async function ensureSynced(index: SearchIndex): Promise<void> {
  const budgetKey = getCurrentBudgetKey();
  if (isSearchIndexSynced(budgetKey)) return;

  const inFlight = _syncInFlight.get(budgetKey);
  if (inFlight) {
    await inFlight;
    return;
  }

  const syncPromise = (async () => {
    const { dirtyGeneration: startDirtyGeneration } = index.getSyncVersions();

    const cache = getResponseCache();
    const startMs = Date.now();
    logger.info('[HybridSearch] Syncing search index from Actual Budget…');

    const [accounts, categories, payees] = await Promise.all([
      cache.getOrFetch<RefAccount[]>(budgetCacheKey('ref:accounts'), {
        ttlMs: 10 * 60_000,
        tags: ['accounts'],
        fetcher: async () => {
          const raw = await adapter.getAccounts();
          return raw.filter((a) => a.id).map((a) => ({ id: a.id!, name: a.name ?? '' }));
        },
      }),
      cache.getOrFetch<RefCategory[]>(budgetCacheKey('ref:categories'), {
        ttlMs: 10 * 60_000,
        tags: ['categories'],
        fetcher: async () => {
          const raw = await adapter.getCategories();
          return raw.filter((c) => c.id).map((c) => ({
            id: c.id!,
            name: c.name ?? '',
            group_id: c.parentId ?? '',
            group_name: '',
          }));
        },
      }),
      cache.getOrFetch<RefPayee[]>(budgetCacheKey('ref:payees'), {
        ttlMs: 10 * 60_000,
        tags: ['payees'],
        fetcher: async () => {
          const raw = await adapter.getPayees();
          return raw.filter((p) => p.id).map((p) => ({ id: p.id!, name: p.name ?? '' }));
        },
      }),
    ]);

    // Build lookup maps
    const accountMap = new Map(accounts.map((a) => [a.id, a.name]));
    const categoryMap = new Map(categories.map((c) => [c.id, c.name]));
    const payeeMap = new Map(payees.map((p) => [p.id, p.name]));

    // Populate reference tables
    index.populateAccounts(accounts);
    index.populateCategories(categories);
    index.populatePayees(payees);

    // Fetch all transactions. Runtime returns more fields than the generated type.
    const rawTxns = await adapter.getTransactions(undefined, undefined, undefined) as unknown as ActualRawTransaction[];

    const indexed: IndexedTransaction[] = rawTxns
      .filter((t): t is ActualRawTransaction & { id: string } => Boolean(t.id))
      .map((t) => ({
        id: t.id,
        date: t.date ?? '',
        amount: t.amount ?? 0,
        notes: t.notes ?? '',
        payee_id: t.payee ?? '',
        payee_name: payeeMap.get(t.payee ?? '') ?? '',
        category_id: t.category ?? '',
        category_name: categoryMap.get(t.category ?? '') ?? '',
        account_id: t.account ?? '',
        account_name: accountMap.get(t.account ?? '') ?? '',
        is_transfer: Boolean(t.transfer_id),
        cleared: Boolean(t.cleared),
      }));

    // Index with embeddings (incremental — skips unchanged rows)
    const wrote = await index.indexTransactions(indexed);

    // Prune rows that no longer exist in Actual Budget
    const currentIds = new Set(indexed.map((t) => t.id));
    const pruned = index.pruneStale(currentIds);

    const persistedMarked = index.tryMarkSyncedGeneration(startDirtyGeneration);
    const memoryMarked = markSearchIndexSyncedIfGeneration(startDirtyGeneration, budgetKey);
    if (!persistedMarked || !memoryMarked) {
      const versions = index.getSyncVersions();
      hydrateSearchSyncState(budgetKey, versions.dirtyGeneration, versions.syncedGeneration);
      logger.warn(
        '[HybridSearch] Sync completed but freshness changed during run; leaving index marked unsynced',
      );
      return;
    }

    logger.info(
      `[HybridSearch] Sync done in ${Date.now() - startMs}ms: ` +
      `${wrote} written, ${pruned} pruned, ${indexed.length} total`,
    );
  })();

  _syncInFlight.set(budgetKey, syncPromise);
  try {
    await syncPromise;
  } finally {
    _syncInFlight.delete(budgetKey);
  }
}

// ---------------------------------------------------------------------------
// Tool definition
// ---------------------------------------------------------------------------

const tool: ToolDefinition = {
  name: 'actual_hybrid_search',
  description:
    'Search transactions using hybrid retrieval: combines keyword matching (BM25), ' +
    'semantic similarity (vector search), and structured metadata filters with ' +
    'Reciprocal Rank Fusion (RRF) scoring. Supports natural-language queries like ' +
    '"coffee shops last month" or "Amazon purchases over $50". Results are ranked ' +
    'by relevance across all search dimensions. Use this for intelligent, flexible ' +
    'transaction discovery instead of rigid filter-based lookups.',
  inputSchema: InputSchema,
  call: wrapToolCall(async (args: unknown, _meta?: unknown) => {
    const input = InputSchema.parse(args || {});

    let index: SearchIndex;
    let engine: HybridSearchEngine;
    let provider: EmbeddingProvider | null;
    try {
      const runtime = await getSearchRuntime();
      index = runtime.index;
      engine = runtime.engine;
      provider = runtime.provider;
    } catch (err) {
      logger.error('[HybridSearch] Failed to initialize search engine:', err);
      return toErrorResult({
        message: 'Search engine initialization failed. The search index may not be available.',
        mode: input.mode,
      });
    }

    // Ensure index is populated
    try {
      await ensureSynced(index);
    } catch (err) {
      logger.error('[HybridSearch] Failed to sync search index:', err);
      return toErrorResult({
        message: 'Search index sync failed. Results may be incomplete or unavailable.',
        mode: input.mode,
      });
    }

    // Auto-downgrade search mode if embeddings are unavailable
    let effectiveMode = input.mode;
    const embeddingReady = provider?.isAvailable() ?? false;
    if (!embeddingReady && (effectiveMode === 'hybrid' || effectiveMode === 'vector')) {
      logger.warn(
        `[HybridSearch] Embedding provider unavailable — downgrading "${effectiveMode}" to "fulltext"`,
      );
      effectiveMode = 'fulltext';
    }

    // Build search query
    const searchQuery: HybridSearchQuery = {
      text: input.query,
      mode: effectiveMode,
      limit: input.limit,
      filters: {
        accountId: input.accountId,
        categoryId: input.categoryId,
        payeeId: input.payeeId,
        startDate: input.startDate,
        endDate: input.endDate,
        minAmount: input.minAmount,
        maxAmount: input.maxAmount,
      },
    };

    let response: SearchResponse;
    try {
      response = await engine.search(searchQuery);
    } catch (err) {
      logger.error('[HybridSearch] Query execution failed:', err);
      return toErrorResult({
        message: `Search query failed: ${err instanceof Error ? err.message : String(err)}`,
        mode: effectiveMode,
      });
    }

    // Format for MCP response
    return {
      results: response.results.map((r) => ({
        ...r.transaction,
        score: r.score,
        matchedBy: r.matchedBy,
        amount_display: `$${(Math.abs(r.transaction.amount) / 100).toFixed(2)}`,
        type: r.transaction.amount < 0 ? 'expense' : 'income',
      })),
      totalMatched: response.totalMatched,
      mode: effectiveMode,
      timing: response.timing,
      indexStats: index.getStats(),
      embeddingProvider: provider?.getInfo() ?? { provider: 'none', available: false },
    };
  }),
};

export default tool;
