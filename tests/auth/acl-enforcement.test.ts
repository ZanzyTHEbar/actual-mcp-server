import { describe, it, expect, vi, beforeEach } from 'vitest';
import { requestContext } from '../../src/lib/requestContext.js';
import { SessionWorkerManager } from '../../src/lib/SessionWorkerManager.js';

// Mock worker_threads to avoid spawning real workers
const mockPostMessage = vi.fn();
vi.mock('worker_threads', () => ({
  Worker: class MockWorker {
    on = vi.fn();
    postMessage = mockPostMessage;
    terminate = vi.fn().mockResolvedValue(undefined);
  },
}));

// Mock config
vi.mock('../../src/config.js', () => ({
  default: {
    MCP_BRIDGE_DATA_DIR: './test-data-dir',
    ACTUAL_BUDGET_SYNC_ID: 'test-budget-123',
    MCP_SESSION_CACHE_CLEANUP: false,
  },
}));

// Mock logger
vi.mock('../../src/logger.js', () => ({
  default: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
}));

// Mock budget-acl
const mockCanAccessBudget = vi.fn();
vi.mock('../../src/auth/budget-acl.js', () => ({
  canAccessBudget: (...args: unknown[]) => mockCanAccessBudget(...args),
}));

describe('ACL enforcement in SessionWorkerManager.executeTool', () => {
  let manager: SessionWorkerManager;
  const sessionId = 'test-session-acl';

  beforeEach(async () => {
    vi.clearAllMocks();
    mockCanAccessBudget.mockReturnValue(true);
    manager = new SessionWorkerManager({ maxSessions: 5, baseDataDir: './test-tmp' });
    await manager.createSession(sessionId);
  });

  it('should return error CallToolResult when identity lacks budget access', async () => {
    mockCanAccessBudget.mockReturnValue(false);

    const result = await requestContext.run(
      {
        sessionId,
        identity: { userId: 'denied-user@example.com', email: 'denied@example.com' },
      },
      async () => {
        return await manager.executeTool(sessionId, 'actual_tool_registry', {});
      }
    );

    expect(mockCanAccessBudget).toHaveBeenCalledWith(
      expect.objectContaining({ userId: 'denied-user@example.com' }),
      'test-budget-123'
    );
    expect(result.isError).toBe(true);
    expect(result.content).toBeDefined();
    const textContent = result.content?.find((c) => c.type === 'text');
    expect(textContent).toBeDefined();
    const text = (textContent as { type: 'text'; text: string })?.text || '';
    expect(text).toContain('Forbidden');
    expect(text).toContain('do not have access');
    expect(mockPostMessage).not.toHaveBeenCalled();
  });
});
