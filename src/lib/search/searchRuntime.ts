/**
 * Shared search runtime — singleton SearchIndex + HybridSearchEngine + EmbeddingProvider
 * per worker process. All search tools use this instead of creating their own instances.
 */

import { SearchIndex } from './SearchIndex.js';
import { HybridSearchEngine } from './HybridSearchEngine.js';
import { buildTransactionText } from './EmbeddingPipeline.js';
import { createEmbeddingProvider, getEmbeddingProvider } from './providers/factory.js';
import { setActiveBudget } from './syncState.js';
import type { EmbeddingProvider } from './providers/types.js';
import type { EmbeddingFunctions } from './SearchIndex.js';
import config from '../../config.js';
import logger from '../../logger.js';

const EMBEDDING_DIMS = 384;

let _index: SearchIndex | null = null;
let _engine: HybridSearchEngine | null = null;
let _initPromise: Promise<void> | null = null;

function getDataDir(): string {
  return process.env.SEARCH_INDEX_DIR
    || process.env.MCP_BRIDGE_DATA_DIR
    || config.MCP_BRIDGE_DATA_DIR
    || './actual-data';
}

function buildEmbeddingFns(provider: EmbeddingProvider): EmbeddingFunctions {
  return {
    embed: (text: string) => provider.embed(text),
    buildTransactionText,
    getModelInfo: () => {
      const info = provider.getInfo();
      return { model: info.model, dimensions: info.dimensions, loaded: info.available };
    },
  };
}

async function initRuntime(): Promise<void> {
  // Set the active budget for sync state tracking
  const budgetId = process.env.ACTUAL_BUDGET_SYNC_ID;
  if (budgetId) {
    setActiveBudget(budgetId);
  }

  const provider = await createEmbeddingProvider();

  if (provider && provider.dimensions !== EMBEDDING_DIMS) {
    logger.error(
      `[SearchRuntime] Dimension mismatch: provider "${provider.providerId}" ` +
      `produces ${provider.dimensions}-dim vectors but index schema expects ${EMBEDDING_DIMS}. ` +
      `Vector search will be disabled.`,
    );
  }

  const dataDir = getDataDir();
  const embeddingFns = provider ? buildEmbeddingFns(provider) : undefined;

  _index = new SearchIndex(dataDir, embeddingFns);
  _index.open();

  _engine = new HybridSearchEngine(
    () => _index!.getDb(),
    provider ? (text: string) => provider.embed(text) : undefined,
  );

  logger.info(`[SearchRuntime] Initialized (dataDir=${dataDir}, provider=${provider?.providerId ?? 'none'})`);
}

export async function getSearchRuntime(): Promise<{
  index: SearchIndex;
  engine: HybridSearchEngine;
  provider: EmbeddingProvider | null;
}> {
  if (_index && _engine) {
    return { index: _index, engine: _engine, provider: getEmbeddingProvider() };
  }

  if (!_initPromise) {
    _initPromise = initRuntime();
  }
  await _initPromise;

  if (!_index || !_engine) {
    throw new Error('Search runtime failed to initialize');
  }

  return { index: _index, engine: _engine, provider: getEmbeddingProvider() };
}

export function getSearchIndex(): SearchIndex | null {
  return _index;
}

export function getSearchEngine(): HybridSearchEngine | null {
  return _engine;
}
