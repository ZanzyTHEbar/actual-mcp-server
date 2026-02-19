/**
 * Search module barrel export.
 *
 * Usage from tools / workers:
 *   import { getResponseCache, SearchIndex, HybridSearchEngine } from '../lib/search/index.js';
 */

export { ResponseCache, getResponseCache, safeGetOrFetch } from './ResponseCache.js';
export { SearchIndex } from './SearchIndex.js';
export { HybridSearchEngine } from './HybridSearchEngine.js';
export { embed, embedBatch, buildTransactionText, getModelInfo } from './EmbeddingPipeline.js';
export { invalidateAfterWrite, isWriteTool } from './CacheInvalidator.js';
export { markSearchIndexDirty, isSearchIndexSynced, markSearchIndexSynced } from './syncState.js';
export { expandQuery, getSynonyms, SYNONYM_GROUP_COUNT, UNIQUE_TERM_COUNT } from './queryExpansion.js';
export { analyzeQuery } from './queryAnalyzer.js';
export type { QueryIntent, QueryAnalysis } from './queryAnalyzer.js';
export { createEmbeddingProvider } from './providers/index.js';
export type { EmbeddingProvider, EmbeddingProviderInfo } from './providers/index.js';
export type {
  IndexedTransaction,
  RefAccount,
  RefCategory,
  RefPayee,
  RefCategoryGroup,
  HybridSearchQuery,
  SearchFilters,
  SearchResult,
  SearchResponse,
  SearchIndexStats,
  CacheTag,
  CacheEntryOptions,
} from './types.js';
