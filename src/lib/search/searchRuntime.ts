/**
 * Shared search runtime — singleton SearchIndex + HybridSearchEngine + EmbeddingProvider
 * per worker process. All search tools use this instead of creating their own instances.
 */

import { SearchIndex } from './SearchIndex.js';
import { HybridSearchEngine } from './HybridSearchEngine.js';
import { buildTransactionText } from './EmbeddingPipeline.js';
import { createEmbeddingProvider } from './providers/factory.js';
import { hydrateSearchSyncState, setActiveBudget } from './syncState.js';
import type { EmbeddingProvider } from './providers/types.js';
import type { EmbeddingFunctions } from './SearchIndex.js';
import config from '../../config.js';
import logger from '../../logger.js';

const EMBEDDING_DIMS = 384;

let _index: SearchIndex | null = null;
let _engine: HybridSearchEngine | null = null;
let _provider: EmbeddingProvider | null = null;
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
  const budgetId = process.env.ACTUAL_BUDGET_SYNC_ID;
  if (budgetId) setActiveBudget(budgetId);

  try {
    const createdProvider = await createEmbeddingProvider();
    let activeProvider = createdProvider;

    if (activeProvider && activeProvider.dimensions !== EMBEDDING_DIMS) {
      logger.error(
        `[SearchRuntime] Dimension mismatch: provider "${activeProvider.providerId}" ` +
        `produces ${activeProvider.dimensions}-dim vectors but index schema expects ${EMBEDDING_DIMS}. ` +
        `Vector search will be disabled.`,
      );
      activeProvider = null;
    }

    const dataDir = getDataDir();
    const embeddingFns = activeProvider ? buildEmbeddingFns(activeProvider) : undefined;

    _index = new SearchIndex(dataDir, embeddingFns);
    _index.open();

    if (budgetId) {
      const versions = _index.getSyncVersions();
      hydrateSearchSyncState(
        budgetId,
        versions.dirtyGeneration,
        versions.syncedGeneration,
      );
    }

    _engine = new HybridSearchEngine(
      () => _index!.getDb(),
      activeProvider ? (text: string) => activeProvider.embed(text) : undefined,
    );
    _provider = activeProvider;

    logger.info(
      `[SearchRuntime] Initialized (dataDir=${dataDir}, provider=${activeProvider?.providerId ?? 'none'})`,
    );
  } catch (err) {
    try {
      _index?.close();
    } catch {
      // best-effort cleanup
    }
    _index = null;
    _engine = null;
    _provider = null;
    throw err;
  }
}

export async function getSearchRuntime(): Promise<{
  index: SearchIndex;
  engine: HybridSearchEngine;
  provider: EmbeddingProvider | null;
}> {
  if (_index && _engine) {
    return { index: _index, engine: _engine, provider: _provider };
  }

  if (!_initPromise) {
    _initPromise = initRuntime();
  }
  try {
    await _initPromise;
  } catch (err) {
    _initPromise = null;
    throw err;
  }

  if (!_index || !_engine) {
    throw new Error('Search runtime failed to initialize');
  }

  return { index: _index, engine: _engine, provider: _provider };
}

export function getSearchIndex(): SearchIndex | null {
  return _index;
}

export function getSearchEngine(): HybridSearchEngine | null {
  return _engine;
}

export function _resetSearchRuntimeForTests(): void {
  try {
    _index?.close();
  } catch {
    // best-effort cleanup
  }
  _index = null;
  _engine = null;
  _provider = null;
  _initPromise = null;
}
