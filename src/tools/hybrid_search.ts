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
  createEmbeddingProvider,
} from '../lib/search/index.js';
import type { EmbeddingProvider } from '../lib/search/index.js';
import { isSearchIndexSynced, markSearchIndexSynced } from '../lib/search/syncState.js';
import { buildTransactionText } from '../lib/search/EmbeddingPipeline.js';
import type {
  IndexedTransaction,
  RefAccount,
  RefCategory,
  RefPayee,
  HybridSearchQuery,
} from '../lib/search/index.js';
import config from '../config.js';
import logger from '../logger.js';

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

// ---------------------------------------------------------------------------
// Singleton index + engine (per worker process)
// ---------------------------------------------------------------------------

let _index: SearchIndex | null = null;
let _engine: HybridSearchEngine | null = null;
let _provider: EmbeddingProvider | null = null;

async function getEngine(): Promise<{ index: SearchIndex; engine: HybridSearchEngine }> {
  if (_index && _engine) {
    return { index: _index, engine: _engine };
  }

  // Create embedding provider via factory (handles config + fallback chain)
  if (!_provider) {
    _provider = await createEmbeddingProvider();
  }

  const dataDir = process.env.SEARCH_INDEX_DIR
    || process.env.MCP_BRIDGE_DATA_DIR
    || config.MCP_BRIDGE_DATA_DIR
    || './actual-data';

  // Inject provider into SearchIndex via the EmbeddingFunctions interface
  const embeddingFns = _provider
    ? {
      embed: (text: string) => _provider!.embed(text),
      buildTransactionText,
      getModelInfo: () => {
        const info = _provider!.getInfo();
        return { model: info.model, dimensions: info.dimensions, loaded: info.available };
      },
    }
    : undefined; // Falls back to default EmbeddingPipeline in SearchIndex

  _index = new SearchIndex(dataDir, embeddingFns);
  _index.open();

  // Inject provider embed fn into HybridSearchEngine
  _engine = new HybridSearchEngine(
    () => _index!.getDb(),
    _provider ? (text: string) => _provider!.embed(text) : undefined,
  );

  return { index: _index, engine: _engine };
}

/**
 * Sync the search index from Actual Budget data.
 * Called lazily on first search, then cached until invalidation.
 */
async function ensureSynced(index: SearchIndex): Promise<void> {
  if (isSearchIndexSynced()) return;

  const cache = getResponseCache();
  const startMs = Date.now();
  logger.info('[HybridSearch] Syncing search index from Actual Budget…');

  // Fetch reference data (these are cached by ResponseCache too)
  const [accounts, categories, payees] = await Promise.all([
    cache.getOrFetch<RefAccount[]>('ref:accounts', {
      ttlMs: 10 * 60_000,
      tags: ['accounts'],
      fetcher: async () => {
        const raw = await adapter.getAccounts();
        return (raw as any[]).map((a: any) => ({ id: a.id, name: a.name ?? '' }));
      },
    }),
    cache.getOrFetch<RefCategory[]>('ref:categories', {
      ttlMs: 10 * 60_000,
      tags: ['categories'],
      fetcher: async () => {
        const raw = await adapter.getCategories();
        return (raw as any[]).map((c: any) => ({
          id: c.id,
          name: c.name ?? '',
          group_id: c.group_id ?? '',
          group_name: '',
        }));
      },
    }),
    cache.getOrFetch<RefPayee[]>('ref:payees', {
      ttlMs: 10 * 60_000,
      tags: ['payees'],
      fetcher: async () => {
        const raw = await adapter.getPayees();
        return (raw as any[]).map((p: any) => ({ id: p.id, name: p.name ?? '' }));
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

  // Fetch all transactions (no account filter, no date filter → everything)
  const rawTxns = await adapter.getTransactions(undefined, undefined, undefined);

  // Map to IndexedTransaction with denormalized names
  const indexed: IndexedTransaction[] = (rawTxns as any[]).map((t: any) => ({
    id: t.id,
    date: t.date ?? '',
    amount: t.amount ?? 0,
    notes: t.notes ?? '',
    payee_id: t.payee ?? '',
    payee_name: payeeMap.get(t.payee) ?? '',
    category_id: t.category ?? '',
    category_name: categoryMap.get(t.category) ?? '',
    account_id: t.account ?? '',
    account_name: accountMap.get(t.account) ?? '',
    is_transfer: Boolean(t.transfer_id),
    cleared: Boolean(t.cleared),
  }));

  // Index with embeddings (incremental — skips unchanged rows)
  const wrote = await index.indexTransactions(indexed);

  // Prune rows that no longer exist in Actual Budget
  const currentIds = new Set(indexed.map((t) => t.id));
  const pruned = index.pruneStale(currentIds);

  markSearchIndexSynced();
  logger.info(
    `[HybridSearch] Sync done in ${Date.now() - startMs}ms: ` +
    `${wrote} written, ${pruned} pruned, ${indexed.length} total`,
  );
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
    try {
      const eng = await getEngine();
      index = eng.index;
      engine = eng.engine;
    } catch (err) {
      logger.error('[HybridSearch] Failed to initialize search engine:', err);
      return {
        error: 'Search engine initialization failed. The search index may not be available.',
        results: [],
        totalMatched: 0,
        mode: input.mode,
        timing: { totalMs: 0 },
      };
    }

    // Ensure index is populated
    try {
      await ensureSynced(index);
    } catch (err) {
      logger.error('[HybridSearch] Failed to sync search index:', err);
      return {
        error: 'Search index sync failed. Results may be incomplete or unavailable.',
        results: [],
        totalMatched: 0,
        mode: input.mode,
        timing: { totalMs: 0 },
      };
    }

    // Auto-downgrade search mode if embeddings are unavailable
    let effectiveMode = input.mode;
    const embeddingReady = _provider?.isAvailable() ?? false;
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

    const response = await engine.search(searchQuery);

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
      embeddingProvider: _provider?.getInfo() ?? { provider: 'none', available: false },
    };
  }),
};

export default tool;
