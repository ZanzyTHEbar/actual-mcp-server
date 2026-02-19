/**
 * actual_search_index_info — expose search index health, stats, and
 * embedding provider information. Uses the shared search runtime singleton.
 */

import { z } from 'zod';
import { wrapToolCall } from '../lib/wrapToolCall.js';
import type { ToolDefinition } from '../../types/tool.d.js';
import { getSearchRuntime, getEmbeddingProvider } from '../lib/search/index.js';
import { isSearchIndexSynced } from '../lib/search/syncState.js';
import logger from '../logger.js';

const InputSchema = z.object({}).optional();

const tool: ToolDefinition = {
  name: 'actual_search_index_info',
  description:
    'Get diagnostic information about the search index: transaction count, ' +
    'last sync time, index size, embedding model/provider status, and sync state. ' +
    'Useful for debugging search issues or verifying index health before querying.',
  inputSchema: InputSchema,
  call: wrapToolCall(async (_args: unknown, _meta?: unknown) => {
    let indexStats: unknown = {};
    let providerInfo: unknown = { provider: 'none', available: false };

    try {
      const { index, provider } = await getSearchRuntime();
      indexStats = index.getStats();
      if (provider) {
        providerInfo = provider.getInfo();
      }
    } catch (err) {
      indexStats = {
        error: `Failed to read index: ${err instanceof Error ? err.message : err}`,
      };
      // Try to get provider info even if index failed
      const provider = getEmbeddingProvider();
      if (provider) {
        providerInfo = provider.getInfo();
      }
    }

    return {
      synced: isSearchIndexSynced(),
      searchEnabled: process.env.SEARCH_ENABLED !== 'false',
      indexStats,
      embeddingProvider: providerInfo,
      config: {
        SEARCH_INDEX_DIR: process.env.SEARCH_INDEX_DIR ?? process.env.MCP_BRIDGE_DATA_DIR ?? './actual-data',
        SEARCH_ENABLED: process.env.SEARCH_ENABLED ?? 'true',
        EMBEDDING_PROVIDER: process.env.EMBEDDING_PROVIDER ?? 'local',
        EMBEDDING_MODEL: process.env.EMBEDDING_MODEL ?? process.env.SEARCH_EMBEDDING_MODEL ?? 'default',
      },
    };
  }),
};

export default tool;
