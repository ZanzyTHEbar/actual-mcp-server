import { parentPort, workerData } from 'worker_threads';
import logger from '../logger.js';
import actualToolsManager from '../actualToolsManager.js';
import { ensureCallToolResult } from '../lib/toolResult.js';

type WorkerMessage =
  | { type: 'executeTool'; requestId: string; toolName: string; args: unknown }
  | { type: 'shutdown' };

const sessionId = workerData?.sessionId as string | undefined;
const dataDir = workerData?.dataDir as string | undefined;

if (dataDir) {
  process.env.MCP_BRIDGE_DATA_DIR = dataDir;
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

  if (message.type === 'executeTool') {
    const { requestId, toolName, args } = message;
    try {
      await ensureInitialized();
      const result = await actualToolsManager.callTool(toolName, args);
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
