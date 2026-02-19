/**
 * actual_search_index_info — expose search index health, stats, and
 * embedding provider information so MCP clients / agents can inspect
 * system readiness before issuing search queries.
 */

import { z } from 'zod';
import { wrapToolCall } from '../lib/wrapToolCall.js';
import type { ToolDefinition } from '../../types/tool.d.js';
import { SearchIndex, createEmbeddingProvider } from '../lib/search/index.js';
import { isSearchIndexSynced } from '../lib/search/syncState.js';
import config from '../config.js';
import logger from '../logger.js';

// ---------------------------------------------------------------------------
// Input schema — no required inputs
// ---------------------------------------------------------------------------

const InputSchema = z.object({}).optional();

// ---------------------------------------------------------------------------
// Tool definition
// ---------------------------------------------------------------------------

const tool: ToolDefinition = {
  name: 'actual_search_index_info',
  description:
    'Get diagnostic information about the search index: transaction count, ' +
    'last sync time, index size, embedding model/provider status, and sync state. ' +
    'Useful for debugging search issues or verifying index health before querying.',
  inputSchema: InputSchema,
  call: wrapToolCall(async (_args: unknown, _meta?: unknown) => {
    const dataDir = process.env.SEARCH_INDEX_DIR
      || process.env.MCP_BRIDGE_DATA_DIR
      || config.MCP_BRIDGE_DATA_DIR
      || './actual-data';

    let indexStats: unknown = {};
    try {
      const idx = new SearchIndex(dataDir);
      idx.open();
      indexStats = idx.getStats();
      idx.close();
    } catch (err) {
      indexStats = {
        error: `Failed to read index: ${err instanceof Error ? err.message : err}`,
      };
    }

    // Get provider info (don't init if not already loaded — just report)
    let providerInfo: unknown = { provider: 'none', available: false };
    try {
      const provider = await createEmbeddingProvider();
      if (provider) {
        providerInfo = provider.getInfo();
      }
    } catch {
      providerInfo = { provider: 'unknown', available: false, error: 'Failed to query provider' };
    }

    return {
      synced: isSearchIndexSynced(),
      searchEnabled: process.env.SEARCH_ENABLED !== 'false',
      indexStats,
      embeddingProvider: providerInfo,
      config: {
        SEARCH_INDEX_DIR: dataDir,
        SEARCH_ENABLED: process.env.SEARCH_ENABLED ?? 'true',
        EMBEDDING_PROVIDER: process.env.EMBEDDING_PROVIDER ?? 'local',
        EMBEDDING_MODEL: process.env.EMBEDDING_MODEL ?? process.env.SEARCH_EMBEDDING_MODEL ?? 'default',
      },
    };
  }),
};

export default tool;
