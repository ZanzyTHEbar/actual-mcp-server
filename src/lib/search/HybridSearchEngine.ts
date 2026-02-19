/**
 * HybridSearchEngine — combines FTS5 BM25, DiskANN vector similarity,
 * and SQL metadata filters using Reciprocal Rank Fusion (RRF).
 *
 * All search logic lives in a single SQL query with CTEs, executed against
 * the libsql SearchIndex database.  This keeps the merge deterministic,
 * auditable, and fast.
 */

import type DatabaseConstructor from 'libsql';
import { embed } from './EmbeddingPipeline.js';
import { getResponseCache } from './ResponseCache.js';
import { expandQuery } from './queryExpansion.js';
import { analyzeQuery } from './queryAnalyzer.js';
import logger from '../../logger.js';
import type {
  HybridSearchQuery,
  SearchResponse,
  SearchResult,
  IndexedTransaction,
} from './types.js';

/** Instance type of a libsql Database (compatible with better-sqlite3). */
type DatabaseInstance = InstanceType<typeof DatabaseConstructor>;

// ---------------------------------------------------------------------------
// Defaults
// ---------------------------------------------------------------------------

const DEFAULT_LIMIT = 25;
const DEFAULT_WEIGHT_FTS = 1.0;
const DEFAULT_WEIGHT_VEC = 0.8;
const RRF_K = 60; // Standard RRF constant

// ---------------------------------------------------------------------------
// HybridSearchEngine
// ---------------------------------------------------------------------------

export class HybridSearchEngine {
  private embedFn: (text: string) => Promise<number[] | null>;

  constructor(
    private getDb: () => DatabaseInstance,
    embedFn?: (text: string) => Promise<number[] | null>,
  ) {
    this.embedFn = embedFn ?? embed;
  }

  /**
   * Execute a hybrid search query.
   *
   * Flow:
   *   1. Parse query → extract text + filters
   *   2. (If text) Generate embedding
   *   3. Run composite SQL (FTS5 + vector + metadata + RRF)
   *   4. Cache and return
   */
  async search(query: HybridSearchQuery): Promise<SearchResponse> {
    const totalStart = Date.now();
    const limit = query.limit ?? DEFAULT_LIMIT;

    // Adaptive mode selection: analyze query to suggest optimal mode + weights
    const hasFilters = Boolean(
      query.filters?.accountId || query.filters?.categoryId || query.filters?.payeeId
      || query.filters?.startDate || query.filters?.endDate
      || query.filters?.minAmount || query.filters?.maxAmount,
    );
    const analysis = analyzeQuery(query.text, hasFilters);

    // Use user-specified mode, or fall back to analyzer recommendation
    const mode = query.mode ?? analysis.recommendedMode ?? 'hybrid';
    const wFts = query.weightFts ?? analysis.ftsWeight ?? DEFAULT_WEIGHT_FTS;
    const wVec = query.weightVec ?? analysis.vecWeight ?? DEFAULT_WEIGHT_VEC;

    if (analysis.recommendedMode && !query.mode) {
      logger.debug(
        `[HybridSearch] Auto-selected mode="${mode}" (intent=${analysis.intent}: ${analysis.reason})`,
      );
    }

    // Check cache first
    const cache = getResponseCache();
    const cacheKey = `search:${JSON.stringify(query)}:v${cache.version}`;
    const cached = cache.peek<SearchResponse>(cacheKey);
    if (cached) {
      return cached;
    }

    const db = this.getDb();
    const timing: SearchResponse['timing'] = { totalMs: 0 };

    // Generate embedding if we have text and need vector search
    let embeddingJson: string | null = null;
    if (query.text && (mode === 'hybrid' || mode === 'vector')) {
      const embStart = Date.now();
      const vec = await this.embedFn(query.text);
      if (vec) {
        embeddingJson = JSON.stringify(vec);
      }
      timing.embeddingMs = Date.now() - embStart;
    }

    // Expand FTS query with financial domain synonyms for better recall
    // Original text → embeddings (semantics), expanded text → FTS5 (keywords)
    const ftsText = query.text ? expandQuery(query.text) : '';
    if (query.text && ftsText !== query.text) {
      logger.debug(`[HybridSearch] Query expanded: "${query.text}" → "${ftsText}"`);
    }

    // Build and execute the appropriate query
    let results: SearchResult[];

    switch (mode) {
      case 'fulltext':
        results = this.executeFulltext(db, ftsText, query.filters, limit);
        break;
      case 'vector':
        results = embeddingJson
          ? this.executeVector(db, embeddingJson, query.filters, limit)
          : [];
        break;
      case 'metadata':
        results = this.executeMetadata(db, query.filters, limit);
        break;
      case 'hybrid':
      default:
        results = await this.executeHybrid(db, ftsText, embeddingJson, query.filters, limit, wFts, wVec);
        break;
    }

    timing.totalMs = Date.now() - totalStart;

    const response: SearchResponse = {
      results,
      totalMatched: results.length,
      query,
      timing,
      queryAnalysis: {
        intent: analysis.intent,
        effectiveMode: mode,
        ftsWeight: wFts,
        vecWeight: wVec,
        reason: analysis.reason,
      },
    };

    // Cache for 2 minutes with search tag
    cache.set(cacheKey, response, { ttlMs: 2 * 60_000, tags: ['search', 'transactions'] });

    return response;
  }

  // -------------------------------------------------------------------------
  // Query executors
  // -------------------------------------------------------------------------

  private executeFulltext(
    db: DatabaseInstance,
    text: string,
    filters: HybridSearchQuery['filters'],
    limit: number,
  ): SearchResult[] {
    if (!text) return [];

    const { where, params } = this.buildMetadataWhere(filters);

    const ftsQuery = this.sanitizeFtsQuery(text);
    const stmt = db.prepare(`
      WITH fts_matches AS (
        SELECT txn_id, rank, row_number() OVER (ORDER BY rank) AS rank_num
        FROM fts_transactions
        WHERE fts_transactions MATCH ?
        LIMIT ?
      )
      SELECT fm.rank_num, fm.rank AS fts_rank,
             t.*
      FROM fts_matches fm
      JOIN transactions t ON t.id = fm.txn_id
      ${where ? `WHERE ${where}` : ''}
      ORDER BY fm.rank_num
      LIMIT ?
    `);

    const rows = stmt.all(ftsQuery, limit * 2, ...Object.values(params), limit) as any[];
    return rows.map((r) => this.rowToResult(r, ['fts']));
  }

  private executeVector(
    db: DatabaseInstance,
    embeddingJson: string,
    filters: HybridSearchQuery['filters'],
    limit: number,
  ): SearchResult[] {
    const { where, params } = this.buildMetadataWhere(filters);

    const stmt = db.prepare(`
      SELECT t.*,
             vector_distance_cos(t.embedding, vector(?)) AS vec_dist,
             row_number() OVER (ORDER BY vector_distance_cos(t.embedding, vector(?))) AS rank_num
      FROM transactions t
      ${where ? `WHERE ${where}` : ''}
      ORDER BY vec_dist
      LIMIT ?
    `);

    const rows = stmt.all(embeddingJson, embeddingJson, ...Object.values(params), limit) as any[];
    return rows.map((r) => this.rowToResult(r, ['vector']));
  }

  private executeMetadata(
    db: DatabaseInstance,
    filters: HybridSearchQuery['filters'],
    limit: number,
  ): SearchResult[] {
    const { where, params } = this.buildMetadataWhere(filters);
    if (!where) {
      // No filters — return most recent
      const rows = db.prepare('SELECT * FROM transactions t ORDER BY t.date DESC LIMIT ?')
        .all(limit) as any[];
      return rows.map((r) => this.rowToResult(r, ['metadata']));
    }

    const stmt = db.prepare(`
      SELECT * FROM transactions t
      WHERE ${where}
      ORDER BY t.date DESC
      LIMIT ?
    `);
    const rows = stmt.all(...Object.values(params), limit) as any[];
    return rows.map((r) => this.rowToResult(r, ['metadata']));
  }

  private async executeHybrid(
    db: DatabaseInstance,
    text: string | undefined,
    embeddingJson: string | null,
    filters: HybridSearchQuery['filters'],
    limit: number,
    wFts: number,
    wVec: number,
  ): Promise<SearchResult[]> {
    // If no text, fall back to metadata-only
    if (!text) {
      return this.executeMetadata(db, filters, limit);
    }

    const ftsQuery = this.sanitizeFtsQuery(text);
    const { where, params } = this.buildMetadataWhere(filters);

    // If we don't have an embedding, fall back to FTS-only
    if (!embeddingJson) {
      return this.executeFulltext(db, text, filters, limit);
    }

    // Full hybrid: FTS5 + Vector + RRF
    const sql = `
      WITH
      -- FTS5 BM25 matches (self-contained FTS5 with txn_id)
      fts_matches AS (
        SELECT txn_id,
               row_number() OVER (ORDER BY rank) AS rank_num
        FROM fts_transactions
        WHERE fts_transactions MATCH ?
        LIMIT ?
      ),
      -- Brute-force vector matches (cosine distance)
      vec_matches AS (
        SELECT id AS txn_id,
               row_number() OVER (ORDER BY vector_distance_cos(embedding, vector(?))) AS rank_num
        FROM transactions
        WHERE embedding IS NOT NULL
        ORDER BY vector_distance_cos(embedding, vector(?))
        LIMIT ?
      ),
      -- Reciprocal Rank Fusion
      fused AS (
        SELECT
          COALESCE(f.txn_id, v.txn_id) AS txn_id,
          f.rank_num AS fts_rank,
          v.rank_num AS vec_rank,
          (COALESCE(1.0 / (${RRF_K} + f.rank_num), 0.0) * ?
         + COALESCE(1.0 / (${RRF_K} + v.rank_num), 0.0) * ?) AS rrf_score
        FROM fts_matches f
        FULL OUTER JOIN vec_matches v ON f.txn_id = v.txn_id
      )
      SELECT
        fused.rrf_score,
        fused.fts_rank,
        fused.vec_rank,
        t.*
      FROM fused
      JOIN transactions t ON t.id = fused.txn_id
      ${where ? `WHERE ${where}` : ''}
      ORDER BY fused.rrf_score DESC
      LIMIT ?
    `;

    const k = limit * 2; // Fetch more candidates for fusion
    // Parameters: FTS MATCH, FTS limit, vec embed×2 (WHERE + ORDER BY), vec limit, RRF weights, metadata filters, final limit
    const allParams = [ftsQuery, k, embeddingJson, embeddingJson, k, wFts, wVec, ...Object.values(params), limit];

    try {
      const rows = db.prepare(sql).all(...allParams) as any[];
      return rows.map((r) => {
        const matchedBy: ('fts' | 'vector' | 'metadata')[] = [];
        if (r.fts_rank != null) matchedBy.push('fts');
        if (r.vec_rank != null) matchedBy.push('vector');
        return this.rowToResult(r, matchedBy);
      });
    } catch (err) {
      logger.error('[HybridSearch] Query failed, falling back to FTS-only:', err);
      return this.executeFulltext(db, text, filters, limit);
    }
  }

  // -------------------------------------------------------------------------
  // Helpers
  // -------------------------------------------------------------------------

  /**
   * Build a SQL WHERE clause from metadata filters.
   * Returns the clause (without leading WHERE) and a param object.
   */
  private buildMetadataWhere(filters?: HybridSearchQuery['filters']): {
    where: string;
    params: Record<string, unknown>;
  } {
    if (!filters) return { where: '', params: {} };

    const conditions: string[] = [];
    const params: Record<string, unknown> = {};

    if (filters.accountId) {
      conditions.push('t.account_id = ?');
      params.accountId = filters.accountId;
    }
    if (filters.categoryId) {
      conditions.push('t.category_id = ?');
      params.categoryId = filters.categoryId;
    }
    if (filters.payeeId) {
      conditions.push('t.payee_id = ?');
      params.payeeId = filters.payeeId;
    }
    if (filters.startDate) {
      conditions.push('t.date >= ?');
      params.startDate = filters.startDate;
    }
    if (filters.endDate) {
      conditions.push('t.date <= ?');
      params.endDate = filters.endDate;
    }
    if (filters.minAmount !== undefined) {
      conditions.push('t.amount >= ?');
      params.minAmount = filters.minAmount;
    }
    if (filters.maxAmount !== undefined) {
      conditions.push('t.amount <= ?');
      params.maxAmount = filters.maxAmount;
    }
    if (filters.isTransfer !== undefined) {
      conditions.push('t.is_transfer = ?');
      params.isTransfer = filters.isTransfer ? 1 : 0;
    }

    return {
      where: conditions.length > 0 ? conditions.join(' AND ') : '',
      params,
    };
  }

  /** Sanitize user input for FTS5 MATCH syntax. */
  private sanitizeFtsQuery(text: string): string {
    // FTS5 special chars: * " ( ) OR AND NOT NEAR
    // Escape by quoting the entire string, or strip specials
    const cleaned = text
      .replace(/['"(){}[\]\\^~!@#$%&]/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();

    if (!cleaned) return '""';

    // Split into words and join with implicit AND (FTS5 default)
    const words = cleaned.split(' ').filter(Boolean);
    // Use prefix matching for the last word to support partial typing
    if (words.length > 0) {
      words[words.length - 1] = words[words.length - 1] + '*';
    }
    return words.join(' ');
  }

  /** Map a raw DB row to a SearchResult. */
  private rowToResult(
    row: any,
    matchedBy: ('fts' | 'vector' | 'metadata')[],
  ): SearchResult {
    const transaction: IndexedTransaction = {
      id: row.id,
      date: row.date,
      amount: row.amount,
      notes: row.notes ?? '',
      payee_id: row.payee_id ?? '',
      payee_name: row.payee_name ?? '',
      category_id: row.category_id ?? '',
      category_name: row.category_name ?? '',
      account_id: row.account_id ?? '',
      account_name: row.account_name ?? '',
      is_transfer: Boolean(row.is_transfer),
      cleared: Boolean(row.cleared),
    };

    return {
      transaction,
      score: row.rrf_score ?? row.rank_num ?? 0,
      ftsRank: row.fts_rank ?? undefined,
      vecDistance: row.vec_rank ?? undefined,
      matchedBy,
    };
  }
}
