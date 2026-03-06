import { parentPort, workerData } from 'worker_threads';
import logger from '../logger.js';
import actualToolsManager from '../actualToolsManager.js';
import { ensureCallToolResult } from '../lib/toolResult.js';
import { markSearchIndexDirty } from '../lib/search/syncState.js';
import { getSearchIndex } from '../lib/search/searchRuntime.js';
import { withBudgetContext } from '../lib/budgetContext.js';
import type { BudgetHandle } from '../lib/budget-registry.js';

type WorkerMessage =
  | { type: 'executeTool'; requestId: string; toolName: string; args: unknown; budget: BudgetHandle }
  | { type: 'markSearchDirty'; budgetKey?: string }
  | { type: 'shutdown' };

const sessionId = workerData?.sessionId as string | undefined;
const dataDir = workerData?.dataDir as string | undefined;
const searchBaseDir = workerData?.searchBaseDir as string | undefined;
const initialBudget = workerData?.initialBudget as BudgetHandle | undefined;

if (dataDir) {
  process.env.MCP_BRIDGE_DATA_DIR = dataDir;
}
if (searchBaseDir) {
  process.env.SEARCH_INDEX_DIR = searchBaseDir;
}
process.env.USE_CONNECTION_POOL = 'false';

let initialized = false;
let initError: Error | null = null;

async function ensureInitialized(): Promise<void> {
  if (initialized) return;
  try {
    await actualToolsManager.initialize();
    initialized = true;
  } catch (err) {
    initError = err instanceof Error ? err : new Error(String(err));
    throw initError;
  }
}

parentPort?.on('message', async (message: WorkerMessage) => {
  if (!message || typeof message !== 'object') return;
  if (message.type === 'shutdown') {
    logger.info(`[Worker] Shutdown requested for session ${sessionId || 'unknown'}`);
    process.exit(0);
  }

  if (message.type === 'markSearchDirty') {
    try {
      markSearchIndexDirty(message.budgetKey);
      const index = message.budgetKey ? getSearchIndex(message.budgetKey) : getSearchIndex();
      if (index) {
        index.bumpDirtyGeneration();
      }
    } catch (err) {
      logger.warn(
        `[Worker] Failed to mark search dirty for session ${sessionId || 'unknown'}: ${String(err)}`,
      );
    }
    return;
  }

  if (message.type === 'executeTool') {
    const { requestId, toolName, args, budget } = message;
    try {
      await ensureInitialized();
      const effectiveBudget = budget || initialBudget;
      if (!effectiveBudget) {
        throw new Error('Budget context is missing for worker execution');
      }
      const result = await withBudgetContext(effectiveBudget, () =>
        actualToolsManager.callTool(toolName, args)
      );
      const callResult = ensureCallToolResult(result);
      parentPort?.postMessage({ type: 'toolResult', requestId, result: callResult });
    } catch (err) {
      const error = err instanceof Error ? err : new Error(String(err));
      parentPort?.postMessage({
        type: 'toolError',
        requestId,
        error: { message: error.message, stack: error.stack },
      });
    }
  }
});

process.on('unhandledRejection', (reason) => {
  const msg = reason instanceof Error ? reason.message : String(reason);
  logger.error(`[Worker] Unhandled rejection in session ${sessionId || 'unknown'}: ${msg}`);
});
