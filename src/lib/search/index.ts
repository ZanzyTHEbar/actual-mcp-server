/**
 * Search module barrel export.
 *
 * Usage from tools / workers:
 *   import { getResponseCache, SearchIndex, HybridSearchEngine } from '../lib/search/index.js';
 */

export { ResponseCache, getResponseCache, safeGetOrFetch } from './ResponseCache.js';
export { SearchIndex } from './SearchIndex.js';
export { HybridSearchEngine } from './HybridSearchEngine.js';
export { buildTransactionText } from './EmbeddingPipeline.js';
export { invalidateAfterWrite, isWriteTool } from './CacheInvalidator.js';
export {
  markSearchIndexDirty, isSearchIndexSynced, markSearchIndexSynced,
  setActiveBudget, getActiveBudget,
} from './syncState.js';
export { expandQuery, getSynonyms, SYNONYM_GROUP_COUNT, UNIQUE_TERM_COUNT } from './queryExpansion.js';
export { analyzeQuery, stripExtractedPatterns } from './queryAnalyzer.js';
export type { QueryIntent, QueryAnalysis } from './queryAnalyzer.js';
export {
  embeddingToF32Blob, f32BlobToEmbedding, embeddingToVectorString, validateDimensions,
} from './embedding-codec.js';
export { detectCapabilities } from './capabilities.js';
export type { DbCapabilities } from './capabilities.js';
export { createEmbeddingProvider, getEmbeddingProvider } from './providers/index.js';
export type { EmbeddingProvider, EmbeddingProviderInfo } from './providers/index.js';
export { getSearchRuntime, getSearchIndex, getSearchEngine } from './searchRuntime.js';
export type {
  DatabaseInstance,
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
  TransactionRow,
  FTSResultRow,
  VecResultRow,
  HybridResultRow,
  HashRow,
  EmbeddingCacheRow,
  PragmaTableInfoRow,
  CountRow,
  SyncMetaRow,
} from './types.js';
