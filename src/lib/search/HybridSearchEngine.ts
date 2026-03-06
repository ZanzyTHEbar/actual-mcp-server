/**
 * HybridSearchEngine — combines FTS5 BM25, DiskANN vector similarity,
 * and SQL metadata filters using Reciprocal Rank Fusion (RRF).
 *
 * All search logic lives in a single SQL query with CTEs, executed against
 * the libsql SearchIndex database.  This keeps the merge deterministic,
 * auditable, and fast.
 */

import { getResponseCache } from './ResponseCache.js';
import { expandQuery } from './queryExpansion.js';
import {
  analyzeQuery,
  deriveDateRangeFromHints,
  stripExtractedPatterns,
} from './queryAnalyzer.js';
import { recordSearchQuery } from '../../observability.js';
import logger from '../../logger.js';
import { budgetCacheKey } from '../budgetContext.js';
import type {
  DatabaseInstance,
  HybridSearchQuery,
  SearchResponse,
  SearchResult,
  IndexedTransaction,
  TransactionRow,
  FTSResultRow,
  VecResultRow,
  HybridResultRow,
  SearchResultRow,
} from './types.js';


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
    this.embedFn = embedFn ?? (async () => null);
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

    // Wire analyzer-extracted amounts into effective filters when the user
    // didn't provide explicit amount filters. Actual stores expenses as
    // negative cents, so "over $50" means amount <= -5000.
    const effectiveFilters = { ...query.filters };
    const userSetAmounts = effectiveFilters.minAmount !== undefined || effectiveFilters.maxAmount !== undefined;
    const userSetDates = effectiveFilters.startDate !== undefined || effectiveFilters.endDate !== undefined;
    if (analysis.extractedAmounts && !userSetAmounts) {
      const { min, max } = analysis.extractedAmounts;
      if (min !== undefined && max !== undefined) {
        // "between $20 and $100" → -10000 <= amount <= -2000
        effectiveFilters.minAmount = -max;
        effectiveFilters.maxAmount = -min;
        logger.debug(`[HybridSearch] Applied extracted amount range: [${effectiveFilters.minAmount}, ${effectiveFilters.maxAmount}]`);
      } else if (min !== undefined) {
        // "over $50" → amount <= -5000 (expenses more negative = larger spend)
        effectiveFilters.maxAmount = -min;
        logger.debug(`[HybridSearch] Applied extracted min amount: maxAmount=${effectiveFilters.maxAmount}`);
      } else if (max !== undefined) {
        // "under $50" → amount >= -5000
        effectiveFilters.minAmount = -max;
        logger.debug(`[HybridSearch] Applied extracted max amount: minAmount=${effectiveFilters.minAmount}`);
      }
    }

    if (analysis.extractedDateHints && analysis.extractedDateHints.length > 0 && !userSetDates) {
      const dateRange = deriveDateRangeFromHints(analysis.extractedDateHints);
      if (dateRange?.startDate || dateRange?.endDate) {
        if (dateRange.startDate) effectiveFilters.startDate = dateRange.startDate;
        if (dateRange.endDate) effectiveFilters.endDate = dateRange.endDate;
        logger.debug(
          `[HybridSearch] Applied extracted date range: ` +
          `${effectiveFilters.startDate ?? 'unset'}..${effectiveFilters.endDate ?? 'unset'}`,
        );
      }
    }

    if (analysis.recommendedMode && !query.mode) {
      logger.debug(
        `[HybridSearch] Auto-selected mode="${mode}" (intent=${analysis.intent}: ${analysis.reason})`,
      );
    }

    // Check cache first
    const cache = getResponseCache();
    const cacheKey = budgetCacheKey(`search:${JSON.stringify(query)}:v${cache.version}`);
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

    // Pipeline: raw user text → sanitize → strip extracted filter patterns → expand
    // sanitize: removes dangerous FTS5 chars from raw user input
    // strip: removes amount/date fragments already extracted into effectiveFilters
    // expand: adds trusted synonym OR-groups (output goes straight to FTS5)
    const sanitized = query.text ? this.sanitizeUserInput(query.text) : '';
    const stripped = sanitized ? stripExtractedPatterns(sanitized) : '';
    const ftsText = stripped ? expandQuery(stripped) : '';
    if (query.text && ftsText !== stripped) {
      logger.debug(`[HybridSearch] FTS pipeline: "${query.text}" → sanitize:"${sanitized}" → strip:"${stripped}" → expand:"${ftsText}"`);
    }

    // Build and execute the appropriate query
    let results: SearchResult[] = await this.executeMode(db, mode, ftsText, embeddingJson, effectiveFilters, limit, wFts, wVec);

    // Post-filter recall: if auto-derived amount filters produced zero results
    // (or auto-derived date filters) produced zero results but we had query text,
    // retry without them. Only relax auto-derived filters,
    // never user-explicit ones.
    const autoFiltersApplied = analysis.extractedAmounts && !userSetAmounts
      && (effectiveFilters.minAmount !== undefined || effectiveFilters.maxAmount !== undefined);
    const autoDateFiltersApplied = analysis.extractedDateHints && !userSetDates
      && (effectiveFilters.startDate !== undefined || effectiveFilters.endDate !== undefined);
    if (results.length === 0 && (autoFiltersApplied || autoDateFiltersApplied) && ftsText) {
      const relaxed = { ...query.filters };
      logger.debug(
        '[HybridSearch] Zero results with auto-derived filters — retrying without inferred date/amount constraints',
      );
      results = await this.executeMode(db, mode, ftsText, embeddingJson, relaxed, limit, wFts, wVec);
    }

    timing.totalMs = Date.now() - totalStart;
    recordSearchQuery(mode, analysis.intent, timing.totalMs).catch(() => { });

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

  private async executeMode(
    db: DatabaseInstance,
    mode: string,
    ftsText: string,
    embeddingJson: string | null,
    filters: HybridSearchQuery['filters'],
    limit: number,
    wFts: number,
    wVec: number,
  ): Promise<SearchResult[]> {
    switch (mode) {
      case 'fulltext':
        return this.executeFulltext(db, ftsText, filters, limit);
      case 'vector':
        return embeddingJson
          ? this.executeVector(db, embeddingJson, filters, limit)
          : [];
      case 'metadata':
        return this.executeMetadata(db, filters, limit);
      case 'hybrid':
      default:
        return this.executeHybrid(db, ftsText, embeddingJson, filters, limit, wFts, wVec);
    }
  }

  private executeFulltext(
    db: DatabaseInstance,
    text: string,
    filters: HybridSearchQuery['filters'],
    limit: number,
  ): SearchResult[] {
    if (!text) return [];

    const { where, params } = this.buildMetadataWhere(filters);

    const ftsQuery = this.prepareFtsQuery(text);
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

    const rows = stmt.all(ftsQuery, limit * 2, ...Object.values(params), limit) as FTSResultRow[];
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
      WITH scored AS (
        SELECT t.*, vector_distance_cos(t.embedding, vector32(?)) AS vec_dist
        FROM transactions t
        WHERE t.embedding IS NOT NULL
        ${where ? `AND ${where}` : ''}
      )
      SELECT *, row_number() OVER (ORDER BY vec_dist) AS rank_num
      FROM scored
      ORDER BY vec_dist
      LIMIT ?
    `);

    const rows = stmt.all(embeddingJson, ...Object.values(params), limit) as VecResultRow[];
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
        .all(limit) as TransactionRow[];
      return rows.map((r) => this.rowToResult(r, ['metadata']));
    }

    const stmt = db.prepare(`
      SELECT * FROM transactions t
      WHERE ${where}
      ORDER BY t.date DESC
      LIMIT ?
    `);
    const rows = stmt.all(...Object.values(params), limit) as TransactionRow[];
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

    const ftsQuery = this.prepareFtsQuery(text);
    const { where, params } = this.buildMetadataWhere(filters);

    // If we don't have an embedding, fall back to FTS-only
    if (!embeddingJson) {
      return this.executeFulltext(db, text, filters, limit);
    }

    // Full hybrid: FTS5 + Vector + RRF
    // vec_matches uses a CTE to compute vector_distance_cos once, then
    // ranks by that pre-computed distance — avoids duplicate function calls.
    const sql = `
      WITH
      fts_matches AS (
        SELECT txn_id,
               row_number() OVER (ORDER BY rank) AS rank_num
        FROM fts_transactions
        WHERE fts_transactions MATCH ?
        LIMIT ?
      ),
      vec_scored AS (
        SELECT id AS txn_id,
               vector_distance_cos(embedding, vector32(?)) AS dist
        FROM transactions
        WHERE embedding IS NOT NULL
      ),
      vec_matches AS (
        SELECT txn_id, row_number() OVER (ORDER BY dist) AS rank_num
        FROM vec_scored
        ORDER BY dist
        LIMIT ?
      ),
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
      SELECT fused.rrf_score, fused.fts_rank, fused.vec_rank, t.*
      FROM fused
      JOIN transactions t ON t.id = fused.txn_id
      ${where ? `WHERE ${where}` : ''}
      ORDER BY fused.rrf_score DESC
      LIMIT ?
    `;

    const k = limit * 2;
    // Parameters: FTS MATCH, FTS limit, vec embed (single), vec limit, RRF weights, metadata filters, final limit
    const allParams = [ftsQuery, k, embeddingJson, k, wFts, wVec, ...Object.values(params), limit];

    try {
      const rows = db.prepare(sql).all(...allParams) as HybridResultRow[];
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

  /**
   * Sanitize raw user input — strip chars that are dangerous in FTS5 MATCH
   * but preserve words intact. Called BEFORE expandQuery so the expansion
   * can safely produce OR / parens / quotes.
   */
  private sanitizeUserInput(text: string): string {
    const cleaned = text
      .replace(/['"{}[\]\\^~!@#$%&]/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
    return cleaned || '';
  }

  /**
   * Prepare expanded text for FTS5 MATCH. The input is already trusted
   * (produced by expandQuery), so OR / parens / quotes are preserved.
   * Inserts explicit AND between adjacent tokens for libsql FTS5 compat
   * (libsql requires explicit AND after closing parens).
   * Adds prefix wildcard to the last bare word for partial-typing support.
   */
  private prepareFtsQuery(text: string): string {
    if (!text.trim()) return '""';

    // Tokenize into segments: parenthesized groups, quoted phrases, bare words, OR keyword
    const tokens: string[] = [];
    const re = /(\([^)]*\))|("(?:[^"\\]|\\.)*")|(\bOR\b)|([\w*]+)/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(text)) !== null) {
      tokens.push(m[0]);
    }

    if (tokens.length === 0) return '""';

    // Join tokens with AND where needed: between adjacent non-OR tokens
    const parts: string[] = [tokens[0]];
    for (let i = 1; i < tokens.length; i++) {
      const prev = tokens[i - 1];
      const cur = tokens[i];
      if (prev === 'OR' || cur === 'OR') {
        parts.push(cur);
      } else {
        parts.push('AND', cur);
      }
    }

    let result = parts.join(' ');

    // Add prefix matching to the last bare word (not inside quotes/parens)
    result = result.replace(/([\w]+)(\s*)$/, '$1*$2').trim();

    return result;
  }

  /** Map a raw DB row to a SearchResult. Accepts any row variant. */
  private rowToResult(
    row: SearchResultRow,
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
      vecDistance: row.vec_dist ?? undefined,
      matchedBy,
    };
  }
}
