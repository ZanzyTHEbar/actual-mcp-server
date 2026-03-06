import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  _resetSearchRuntimeForTests,
  getSearchRuntime,
} from '../../src/lib/search/searchRuntime.js';

const state = vi.hoisted(() => ({
  failFirstInit: true,
  createProvider: vi.fn(async () => ({
    providerId: 'mock',
    modelId: 'mock-model',
    dimensions: 384,
    init: async () => true,
    isAvailable: () => true,
    embed: async (_text: string) => new Array(384).fill(0),
    embedBatch: async (texts: string[]) => texts.map(() => new Array(384).fill(0)),
    getInfo: () => ({
      provider: 'mock',
      model: 'mock-model',
      dimensions: 384,
      available: true,
    }),
  })),
  mockDb: {},
}));

vi.mock('../../src/lib/search/providers/factory.js', () => ({
  createEmbeddingProvider: state.createProvider,
}));

vi.mock('../../src/lib/search/EmbeddingPipeline.js', () => ({
  buildTransactionText: () => 'mock text',
}));

vi.mock('../../src/lib/search/SearchIndex.js', () => {
  class MockSearchIndex {
    constructor(..._args: unknown[]) {}

    open() {
      if (state.failFirstInit) {
        state.failFirstInit = false;
        throw new Error('simulated init failure');
      }
    }

    close() {}

    getDb() {
      return state.mockDb;
    }

    getSyncVersions() {
      return { dirtyGeneration: 0, syncedGeneration: 0, lastSyncedAt: null };
    }
  }

  return { SearchIndex: MockSearchIndex };
});

vi.mock('../../src/lib/search/HybridSearchEngine.js', () => ({
  HybridSearchEngine: class MockHybridSearchEngine {
    constructor(..._args: unknown[]) {}
  },
}));

vi.mock('../../src/config.js', () => ({
  default: {
    MCP_BRIDGE_DATA_DIR: './test-data-dir',
  },
}));

vi.mock('../../src/logger.js', () => ({
  default: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
}));

describe('searchRuntime initialization retryability', () => {
  beforeEach(() => {
    _resetSearchRuntimeForTests();
    state.failFirstInit = true;
    state.createProvider.mockClear();
  });

  it('retries initialization after first failure', async () => {
    await expect(getSearchRuntime()).rejects.toThrow(/simulated init failure/i);
    await expect(getSearchRuntime()).resolves.toMatchObject({
      index: expect.any(Object),
      engine: expect.any(Object),
      provider: expect.objectContaining({ providerId: 'mock' }),
    });
    expect(state.createProvider).toHaveBeenCalledTimes(2);
  });
});
