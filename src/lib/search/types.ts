/**
 * Shared types for the hybrid search + cache layer.
 *
 * These types bridge the Actual Budget domain model with the search engine
 * and response cache so every layer speaks the same language.
 */

import type DatabaseConstructor from 'libsql';

/** libsql Database instance type, used across search modules. */
export type DatabaseInstance = InstanceType<typeof DatabaseConstructor>;

// ---------------------------------------------------------------------------
// Domain entities (denormalized for indexing)
// ---------------------------------------------------------------------------

/** A single transaction row as stored in the search index. */
export interface IndexedTransaction {
  /** Actual Budget transaction ID (UUID). */
  id: string;
  /** ISO date string (YYYY-MM-DD). */
  date: string;
  /** Amount in cents (negative = expense, positive = income). */
  amount: number;
  /** Notes / memo text (may be empty). */
  notes: string;
  /** Payee UUID. */
  payee_id: string;
  /** Payee display name (denormalized for FTS). */
  payee_name: string;
  /** Category UUID. */
  category_id: string;
  /** Category display name (denormalized for FTS). */
  category_name: string;
  /** Account UUID. */
  account_id: string;
  /** Account display name (denormalized for FTS). */
  account_name: string;
  /** Whether this is a transfer transaction. */
  is_transfer: boolean;
  /** Whether this transaction has been cleared / reconciled. */
  cleared: boolean;
}

/** Lightweight reference entity used for cache lookups. */
export interface RefAccount {
  id: string;
  name: string;
  type?: string;
  offbudget?: boolean;
  closed?: boolean;
}

export interface RefCategory {
  id: string;
  name: string;
  group_id?: string;
  group_name?: string;
}

export interface RefPayee {
  id: string;
  name: string;
}

export interface RefCategoryGroup {
  id: string;
  name: string;
}

// ---------------------------------------------------------------------------
// Database row types (what SQLite actually returns)
// ---------------------------------------------------------------------------

/** Raw transaction row from the `transactions` table. */
export interface TransactionRow {
  id: string;
  date: string;
  amount: number;
  notes: string | null;
  payee_id: string | null;
  payee_name: string | null;
  category_id: string | null;
  category_name: string | null;
  account_id: string | null;
  account_name: string | null;
  is_transfer: number; // SQLite boolean: 0 or 1
  cleared: number;     // SQLite boolean: 0 or 1
  content_hash: string;
  embedding: Uint8Array | null; // F32_BLOB or NULL
}

/** Row returned from FTS5 fulltext search with join. */
export interface FTSResultRow extends TransactionRow {
  rank_num: number;
  fts_rank: number;
}

/** Row returned from vector similarity search. */
export interface VecResultRow extends TransactionRow {
  vec_dist: number;
  rank_num: number;
}

/** Row returned from the full hybrid RRF query. */
export interface HybridResultRow extends TransactionRow {
  rrf_score: number;
  fts_rank: number | null;
  vec_rank: number | null;
}

/**
 * Union of all possible search row types that rowToResult must handle.
 * Every variant has the TransactionRow base plus optional score fields.
 */
export type SearchResultRow = TransactionRow & {
  rank_num?: number;
  fts_rank?: number | null;
  vec_dist?: number;
  vec_rank?: number | null;
  rrf_score?: number;
};

/** Row from `SELECT id, content_hash FROM transactions`. */
export interface HashRow {
  id: string;
  content_hash: string;
}

/** Row from `SELECT embedding FROM embedding_cache`. */
export interface EmbeddingCacheRow {
  text_hash: string;
  embedding: Buffer | Uint8Array; // F32_BLOB binary (LE float32)
  created_at: string;
}

/** Row from `PRAGMA table_info(...)`. */
export interface PragmaTableInfoRow {
  cid: number;
  name: string;
  type: string;
  notnull: number;
  dflt_value: string | null;
  pk: number;
}

/** Row from `SELECT COUNT(*) as c ...`. */
export interface CountRow {
  c: number;
}

/** Row from sync_meta table. */
export interface SyncMetaRow {
  key: string;
  value: string;
}

// ---------------------------------------------------------------------------
// Search query / result types
// ---------------------------------------------------------------------------

/** Structured search request from the MCP tool layer. */
export interface HybridSearchQuery {
  /** Free-text query (used for both FTS5 and embedding). */
  text?: string;
  /** Hard metadata filters applied before search scoring. */
  filters?: SearchFilters;
  /** Maximum results to return (default 25). */
  limit?: number;
  /** Search mode override. */
  mode?: 'hybrid' | 'fulltext' | 'vector' | 'metadata';
  /** Weight for FTS5 BM25 component (default 1.0). */
  weightFts?: number;
  /** Weight for vector cosine component (default 0.8). */
  weightVec?: number;
}

export interface SearchFilters {
  accountId?: string;
  categoryId?: string;
  payeeId?: string;
  startDate?: string;
  endDate?: string;
  minAmount?: number;
  maxAmount?: number;
  isTransfer?: boolean;
}

/** A single search result with scoring metadata. */
export interface SearchResult {
  /** The matched transaction. */
  transaction: IndexedTransaction;
  /** Combined RRF score (higher = more relevant). */
  score: number;
  /** FTS5 BM25 rank position (undefined if not matched). */
  ftsRank?: number;
  /** Vector cosine distance (undefined if not matched). */
  vecDistance?: number;
  /** Which search modes contributed to this result. */
  matchedBy: ('fts' | 'vector' | 'metadata')[];
}

export interface SearchResponse {
  results: SearchResult[];
  totalMatched: number;
  query: HybridSearchQuery;
  timing: {
    totalMs: number;
    ftsMs?: number;
    vecMs?: number;
    embeddingMs?: number;
  };
  queryAnalysis?: {
    intent: string;
    effectiveMode: string;
    ftsWeight: number;
    vecWeight: number;
    reason: string;
  };
}

// ---------------------------------------------------------------------------
// Cache types
// ---------------------------------------------------------------------------

/** Tags used for targeted cache invalidation. */
export type CacheTag =
  | 'accounts'
  | 'categories'
  | 'category_groups'
  | 'payees'
  | 'transactions'
  | 'budgets'
  | 'rules'
  | 'search';

/** Configuration for a cached entry. */
export interface CacheEntryOptions {
  /** Time-to-live in milliseconds. */
  ttlMs: number;
  /** Tags for group invalidation. */
  tags: CacheTag[];
}

// ---------------------------------------------------------------------------
// Search index lifecycle
// ---------------------------------------------------------------------------

export interface SearchIndexStats {
  totalTransactions: number;
  totalAccounts: number;
  totalCategories: number;
  totalPayees: number;
  embeddingCacheEntries: number;
  indexSizeBytes: number;
  lastSyncedAt: string | null;
  embeddingModel: string;
  embeddingDimensions: number;
}
