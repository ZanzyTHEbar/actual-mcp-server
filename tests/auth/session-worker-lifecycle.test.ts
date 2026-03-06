import { describe, it, expect, vi, beforeEach } from 'vitest';
import { SessionWorkerManager } from '../../src/lib/SessionWorkerManager.js';

type Listener = (...args: unknown[]) => void;
type MockWorkerLike = {
  emit: (event: string, ...args: unknown[]) => void;
  postMessage: ReturnType<typeof vi.fn>;
  terminate: ReturnType<typeof vi.fn>;
};

const mockState = vi.hoisted(() => ({
  workers: [] as MockWorkerLike[],
}));

vi.mock('worker_threads', () => {
  class WorkerMock {
    private listeners = new Map<string, Listener>();
    on = vi.fn((event: string, cb: Listener) => {
      this.listeners.set(event, cb);
    });
    postMessage = vi.fn();
    terminate = vi.fn(async () => undefined);

    constructor(..._args: unknown[]) {
      mockState.workers.push(this as unknown as MockWorkerLike);
    }

    emit(event: string, ...args: unknown[]) {
      const listener = this.listeners.get(event);
      if (listener) listener(...args);
    }
  }

  return { Worker: WorkerMock };
});

vi.mock('../../src/config.js', () => ({
  default: {
    MCP_BRIDGE_DATA_DIR: './test-data-dir',
    ACTUAL_BUDGET_SYNC_ID: 'test-budget-123',
    MCP_SESSION_CACHE_CLEANUP: false,
    SESSION_TOOL_TIMEOUT_MS: 200,
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

vi.mock('../../src/auth/budget-acl.js', () => ({
  canAccessBudget: vi.fn(() => true),
}));

function getLastWorker(): MockWorkerLike {
  const worker = mockState.workers[mockState.workers.length - 1];
  if (!worker) throw new Error('Expected at least one mock worker');
  return worker;
}

describe('SessionWorkerManager lifecycle reliability', () => {
  beforeEach(() => {
    mockState.workers.length = 0;
    vi.clearAllMocks();
  });

  it('rejects pending requests when worker emits error', async () => {
    const manager = new SessionWorkerManager({
      maxSessions: 2,
      baseDataDir: './test-tmp',
      toolCallTimeoutMs: 10_000,
    });
    await manager.createSession('session-error');
    const worker = getLastWorker();

    const pending = manager.executeTool('session-error', 'actual_transactions_get', {});
    worker.emit('error', new Error('simulated worker crash'));

    await expect(pending).rejects.toThrow(/Worker errored for session session-error/i);
  });

  it('rejects pending requests when worker exits unexpectedly', async () => {
    const manager = new SessionWorkerManager({
      maxSessions: 2,
      baseDataDir: './test-tmp',
      toolCallTimeoutMs: 10_000,
    });
    await manager.createSession('session-exit');
    const worker = getLastWorker();

    const pending = manager.executeTool('session-exit', 'actual_transactions_get', {});
    worker.emit('exit', 1);

    await expect(pending).rejects.toThrow(/Worker exited for session session-exit with code 1/i);
    const stats = manager.getStats();
    expect(stats.totalSessions).toBe(0);
  });

  it('rejects and clears pending requests when closeSession is called', async () => {
    const manager = new SessionWorkerManager({
      maxSessions: 2,
      baseDataDir: './test-tmp',
      toolCallTimeoutMs: 10_000,
    });
    await manager.createSession('session-close');
    const worker = getLastWorker();

    const pending = manager.executeTool('session-close', 'actual_transactions_get', {});
    await manager.closeSession('session-close');

    await expect(pending).rejects.toThrow(/Session session-close is closing/i);
    expect(worker.terminate).toHaveBeenCalledTimes(1);
    const stats = manager.getStats();
    expect(stats.totalSessions).toBe(0);
  });

  it('returns deterministic timeout CallToolResult when worker does not respond', async () => {
    const manager = new SessionWorkerManager({
      maxSessions: 2,
      baseDataDir: './test-tmp',
      toolCallTimeoutMs: 10,
    });
    await manager.createSession('session-timeout');

    const result = await manager.executeTool('session-timeout', 'actual_transactions_get', {});

    expect(result.isError).toBe(true);
    const text = result.content?.find((c) => c.type === 'text')?.text ?? '';
    expect(text).toContain('timed out');
    expect(text).toContain('actual_transactions_get');
  });

  it('broadcasts search dirty signal to active workers after successful write', async () => {
    const manager = new SessionWorkerManager({
      maxSessions: 5,
      baseDataDir: './test-tmp',
      toolCallTimeoutMs: 10_000,
    });

    await manager.createSession('writer-session');
    const writerWorker = getLastWorker();
    await manager.createSession('reader-session');
    const readerWorker = getLastWorker();

    const executePromise = manager.executeTool('writer-session', 'actual_transactions_update', {
      id: 'txn-1',
    });
    await vi.waitFor(() => {
      expect(writerWorker.postMessage).toHaveBeenCalled();
    });
    const executeMsg = writerWorker.postMessage.mock.calls[0][0] as {
      requestId: string;
    };

    writerWorker.emit('message', {
      type: 'toolResult',
      requestId: executeMsg.requestId,
      result: { content: [{ type: 'text', text: 'ok' }] },
    });
    await executePromise;

    expect(writerWorker.postMessage).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'markSearchDirty' }),
    );
    expect(readerWorker.postMessage).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'markSearchDirty' }),
    );
  });
});
