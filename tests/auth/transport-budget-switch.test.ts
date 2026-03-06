import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AddressInfo } from 'net';
import type { AuthIdentity, AuthProvider } from '../../src/auth/types.js';

vi.mock('../../src/logger.js', () => ({
  default: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
  sanitizeForLog: (value: unknown) => String(value),
  sanitizeError: (err: unknown) => err instanceof Error ? err : new Error(String(err)),
}));

vi.mock('../../src/actualToolsManager.js', () => ({
  default: {
    getTool: vi.fn((name: string) => ({ description: `Tool ${name}` })),
    getToolSchema: vi.fn(() => ({ type: 'object', properties: {}, additionalProperties: false })),
    initialize: vi.fn(async () => undefined),
    listTools: vi.fn(() => []),
  },
}));

const mockState = vi.hoisted(() => ({
  sessions: new Map<string, { identity?: AuthIdentity; activeBudget: string }>(),
}));

function toCallToolResult(payload: unknown, isError = false) {
  return {
    content: [{ type: 'text', text: JSON.stringify(payload) }],
    ...(isError ? { isError: true } : {}),
  };
}

vi.mock('../../src/lib/SessionWorkerManager.js', () => ({
  sessionWorkerManager: {
    canAcceptNewSession: vi.fn(() => true),
    createSession: vi.fn(async (sessionId: string, identity?: AuthIdentity) => {
      mockState.sessions.set(sessionId, { identity, activeBudget: 'Home' });
    }),
    closeSession: vi.fn(async (sessionId: string) => {
      mockState.sessions.delete(sessionId);
    }),
    touchSession: vi.fn(),
    getStats: vi.fn(() => ({
      maxConcurrent: 5,
      activeSessions: mockState.sessions.size,
      totalSessions: mockState.sessions.size,
      sessions: [...mockState.sessions.entries()].map(([sessionId, info]) => ({
        sessionId,
        idleMinutes: 0,
        activeBudget: { name: info.activeBudget },
      })),
    })),
    executeTool: vi.fn(async (sessionId: string, toolName: string, args: Record<string, unknown>) => {
      const session = mockState.sessions.get(sessionId);
      if (!session) {
        return toCallToolResult({ message: 'missing session' }, true);
      }

      const allBudgets = [
        { name: 'Home', syncId: 'home-budget', budgetKey: 'home-key', serverUrl: 'http://localhost:5006', usesEncryption: false },
        { name: 'Team Budget', syncId: 'team-budget', budgetKey: 'team-key', serverUrl: 'http://localhost:5006', usesEncryption: false },
        { name: 'Team Ops', syncId: 'team-ops', budgetKey: 'ops-key', serverUrl: 'http://localhost:5006', usesEncryption: false },
      ];

      const allowed = session.identity?.userId === 'bob@example.com'
        ? ['Home']
        : ['Home', 'Team Budget', 'Team Ops'];

      if (toolName === 'actual_budgets_list_available') {
        const budgets = allBudgets
          .filter((budget) => allowed.includes(budget.name))
          .map((budget) => ({ ...budget, active: budget.name === session.activeBudget }));
        return toCallToolResult({
          budgets,
          count: budgets.length,
          hint: 'Pass a budget name to actual_budgets_switch to change the active budget for this session.',
        });
      }

      if (toolName === 'actual_budgets_switch') {
        const budgetName = String(args?.budgetName ?? '');
        const allowedBudgets = allBudgets.filter((budget) => allowed.includes(budget.name));
        const exact = allowedBudgets.find((budget) => budget.name.toLowerCase() === budgetName.toLowerCase());
        if (exact) {
          session.activeBudget = exact.name;
          return toCallToolResult({
            success: true,
            budgetName: exact.name,
            budgetId: exact.syncId,
            budgetKey: exact.budgetKey,
            serverUrl: exact.serverUrl,
            message: `Switched to budget "${exact.name}" for session ${sessionId}`,
          });
        }

        const partialMatches = allowedBudgets.filter((budget) =>
          budget.name.toLowerCase().includes(budgetName.toLowerCase()),
        );
        if (partialMatches.length > 1) {
          return toCallToolResult({
            message: `Multiple budgets match "${budgetName}". Matching budgets: ${partialMatches.map((budget) => budget.name).join(', ')}`,
          }, true);
        }
        if (partialMatches.length === 0) {
          return toCallToolResult({
            message: `No configured budget matched "${budgetName}"`,
          }, true);
        }
      }

      if (toolName === 'actual_server_info') {
        return toCallToolResult({
          budgetName: session.activeBudget,
        });
      }

      return toCallToolResult({ message: `Unhandled tool ${toolName}` }, true);
    }),
  },
}));

vi.mock('../../src/config.js', () => {
  return {
    default: new Proxy({} as Record<string, unknown>, {
      get(target, prop) { return target[prop as string]; },
      set(target, prop, value) { target[prop as string] = value; return true; },
      deleteProperty(target, prop) { delete target[prop as string]; return true; },
    }),
  };
});

import config from '../../src/config.js';
import { startHttpServer } from '../../src/server/httpServer.js';

function resetConfig() {
  const c = config as Record<string, unknown>;
  Object.keys(c).forEach((k) => delete c[k]);
}

async function waitForListening(server: { listening: boolean; once: (event: string, cb: () => void) => void }) {
  if (server.listening) return;
  await new Promise<void>((resolve) => server.once('listening', resolve));
}

async function initializeSession(port: number, token: string) {
  const initRes = await fetch(`http://127.0.0.1:${port}/mcp`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream',
    },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {
        protocolVersion: '2025-06-18',
        capabilities: {},
        clientInfo: { name: 'transport-budget-test', version: '0.0.0-test' },
      },
    }),
  });

  expect(initRes.status).toBe(200);
  const sessionId = initRes.headers.get('mcp-session-id');
  expect(sessionId).toBeTruthy();
  return sessionId!;
}

async function callTool(port: number, sessionId: string, token: string, name: string, args: Record<string, unknown> = {}) {
  const res = await fetch(`http://127.0.0.1:${port}/mcp`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      Accept: 'application/json',
      'mcp-session-id': sessionId,
    },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: Math.floor(Math.random() * 1000),
      method: 'tools/call',
      params: {
        name,
        arguments: args,
      },
    }),
  });
  expect(res.status).toBe(200);
  const json = await res.json();
  const text = json?.result?.content?.find((entry: { type: string }) => entry.type === 'text')?.text ?? '{}';
  return { envelope: json, payload: JSON.parse(text) };
}

describe('HTTP transport multi-budget flow', () => {
  const cleanups: Array<() => Promise<void>> = [];

  beforeEach(() => {
    resetConfig();
    mockState.sessions.clear();
    (config as any).OIDC_SCOPES = ['read', 'write'];
  });

  afterEach(async () => {
    while (cleanups.length > 0) {
      await cleanups.pop()?.();
    }
  });

  it('covers ACL filtering, ambiguous names, and post-switch session isolation over transport', async () => {
    const authProvider: AuthProvider = {
      name: 'oidc',
      validateCredential: vi.fn(async (token: string) => {
        if (token === 'bob-token') {
          return { userId: 'bob@example.com', scopes: ['read', 'write'] };
        }
        return { userId: 'alice@example.com', scopes: ['read', 'write'] };
      }),
    };

    const { listener, cleanup } = await startHttpServer(
      {} as never,
      0,
      '/mcp',
      {},
      ['actual_budgets_list_available', 'actual_budgets_switch', 'actual_server_info'],
      'actual-mcp-server',
      'instructions',
      {
        actual_budgets_list_available: { type: 'object', properties: {}, additionalProperties: false },
        actual_budgets_switch: {
          type: 'object',
          properties: { budgetName: { type: 'string' } },
          required: ['budgetName'],
          additionalProperties: false,
        },
        actual_server_info: { type: 'object', properties: {}, additionalProperties: false },
      },
      '0.0.0-test',
      '127.0.0.1',
      undefined,
      authProvider,
    );
    await waitForListening(listener);
    const port = (listener.address() as AddressInfo).port;
    cleanups.push(async () => {
      await cleanup();
      await new Promise<void>((resolve, reject) => listener.close((err) => err ? reject(err) : resolve()));
    });

    const aliceSession = await initializeSession(port, 'alice-token');
    const bobSession = await initializeSession(port, 'bob-token');

    const aliceBudgets = await callTool(port, aliceSession, 'alice-token', 'actual_budgets_list_available');
    expect(aliceBudgets.payload.count).toBe(3);
    expect(aliceBudgets.payload.budgets.map((budget: { name: string }) => budget.name)).toEqual([
      'Home',
      'Team Budget',
      'Team Ops',
    ]);

    const bobBudgets = await callTool(port, bobSession, 'bob-token', 'actual_budgets_list_available');
    expect(bobBudgets.payload.count).toBe(1);
    expect(bobBudgets.payload.budgets[0].name).toBe('Home');

    const ambiguous = await callTool(port, aliceSession, 'alice-token', 'actual_budgets_switch', { budgetName: 'Team' });
    expect(ambiguous.envelope.result.isError).toBe(true);
    expect(ambiguous.payload.message).toContain('Multiple budgets match');

    const switched = await callTool(port, aliceSession, 'alice-token', 'actual_budgets_switch', { budgetName: 'Team Budget' });
    expect(switched.payload.success).toBe(true);
    expect(switched.payload.budgetName).toBe('Team Budget');

    const aliceInfo = await callTool(port, aliceSession, 'alice-token', 'actual_server_info');
    const bobInfo = await callTool(port, bobSession, 'bob-token', 'actual_server_info');
    expect(aliceInfo.payload.budgetName).toBe('Team Budget');
    expect(bobInfo.payload.budgetName).toBe('Home');

    const forbiddenSwitch = await callTool(port, bobSession, 'bob-token', 'actual_budgets_switch', { budgetName: 'Team Budget' });
    expect(forbiddenSwitch.envelope.result.isError).toBe(true);
    expect(forbiddenSwitch.payload.message).toContain('No configured budget matched');
  });
});
