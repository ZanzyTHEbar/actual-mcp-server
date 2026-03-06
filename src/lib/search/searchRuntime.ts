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
import { getCurrentBudgetHandle, resolveBudgetSearchIndexDir } from '../budgetContext.js';

const EMBEDDING_DIMS = 384;

type SearchRuntimeEntry = {
  budgetKey: string;
  dataDir: string;
  index: SearchIndex | null;
  engine: HybridSearchEngine | null;
  provider: EmbeddingProvider | null;
  initPromise: Promise<void> | null;
};

const _runtimes = new Map<string, SearchRuntimeEntry>();

function getDataDir(): string {
  return resolveBudgetSearchIndexDir(
    process.env.SEARCH_INDEX_DIR
    || process.env.MCP_BRIDGE_DATA_DIR
    || config.MCP_BRIDGE_DATA_DIR
    || './actual-data',
  );
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

function getOrCreateRuntimeEntry(): SearchRuntimeEntry {
  const budget = getCurrentBudgetHandle();
  const budgetKey = budget.budgetKey;
  const existing = _runtimes.get(budgetKey);
  if (existing) {
    setActiveBudget(budgetKey);
    return existing;
  }

  const entry: SearchRuntimeEntry = {
    budgetKey,
    dataDir: getDataDir(),
    index: null,
    engine: null,
    provider: null,
    initPromise: null,
  };
  _runtimes.set(budgetKey, entry);
  setActiveBudget(budgetKey);
  return entry;
}

async function initRuntime(entry: SearchRuntimeEntry): Promise<void> {
  setActiveBudget(entry.budgetKey);

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

    const embeddingFns = activeProvider ? buildEmbeddingFns(activeProvider) : undefined;

    entry.index = new SearchIndex(entry.dataDir, embeddingFns);
    entry.index.open();

    if (entry.budgetKey) {
      const versions = entry.index.getSyncVersions();
      hydrateSearchSyncState(
        entry.budgetKey,
        versions.dirtyGeneration,
        versions.syncedGeneration,
      );
    }

    entry.engine = new HybridSearchEngine(
      () => entry.index!.getDb(),
      activeProvider ? (text: string) => activeProvider.embed(text) : undefined,
    );
    entry.provider = activeProvider;

    logger.info(
      `[SearchRuntime] Initialized (budget=${entry.budgetKey}, dataDir=${entry.dataDir}, provider=${activeProvider?.providerId ?? 'none'})`,
    );
  } catch (err) {
    try {
      entry.index?.close();
    } catch {
      // best-effort cleanup
    }
    entry.index = null;
    entry.engine = null;
    entry.provider = null;
    throw err;
  } finally {
    entry.initPromise = null;
  }
}

export async function getSearchRuntime(): Promise<{
  index: SearchIndex;
  engine: HybridSearchEngine;
  provider: EmbeddingProvider | null;
}> {
  const entry = getOrCreateRuntimeEntry();

  if (entry.index && entry.engine) {
    return { index: entry.index, engine: entry.engine, provider: entry.provider };
  }

  if (!entry.initPromise) {
    entry.initPromise = initRuntime(entry);
  }
  try {
    await entry.initPromise;
  } catch (err) {
    throw err;
  }

  if (!entry.index || !entry.engine) {
    throw new Error('Search runtime failed to initialize');
  }

  return { index: entry.index, engine: entry.engine, provider: entry.provider };
}

export function getSearchIndex(budgetKey?: string): SearchIndex | null {
  const resolvedBudgetKey = budgetKey ?? getCurrentBudgetHandle().budgetKey;
  return _runtimes.get(resolvedBudgetKey)?.index ?? null;
}

export function getSearchEngine(budgetKey?: string): HybridSearchEngine | null {
  const resolvedBudgetKey = budgetKey ?? getCurrentBudgetHandle().budgetKey;
  return _runtimes.get(resolvedBudgetKey)?.engine ?? null;
}

export function _resetSearchRuntimeForTests(): void {
  for (const entry of _runtimes.values()) {
    try {
      entry.index?.close();
    } catch {
      // best-effort cleanup
    }
  }
  _runtimes.clear();
}
