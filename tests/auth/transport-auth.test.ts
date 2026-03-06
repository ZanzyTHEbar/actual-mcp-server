import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AddressInfo } from 'net';
import type { AuthProvider } from '../../src/auth/types.js';

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
    getTool: vi.fn(() => null),
    getToolSchema: vi.fn(() => null),
    initialize: vi.fn(async () => undefined),
    listTools: vi.fn(() => []),
  },
}));

vi.mock('../../src/lib/SessionWorkerManager.js', () => ({
  sessionWorkerManager: {
    canAcceptNewSession: vi.fn(() => true),
    createSession: vi.fn(async () => undefined),
    closeSession: vi.fn(async () => undefined),
    touchSession: vi.fn(),
    executeTool: vi.fn(async () => ({ content: [{ type: 'text', text: '{}' }] })),
    getStats: vi.fn(() => ({ maxConcurrent: 5, activeSessions: 0 })),
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
import { startSseServer } from '../../src/server/sseServer.js';

function resetConfig() {
  const c = config as Record<string, unknown>;
  Object.keys(c).forEach((k) => delete c[k]);
}

async function waitForListening(server: { listening: boolean; once: (event: string, cb: () => void) => void }) {
  if (server.listening) return;
  await new Promise<void>((resolve) => server.once('listening', resolve));
}

describe('transport auth surfaces', () => {
  const cleanups: Array<() => Promise<void>> = [];

  beforeEach(() => {
    resetConfig();
    (config as any).OIDC_SCOPES = ['read', 'write'];
    (config as any).OIDC_RESOURCE = 'https://mcp.example.com/http';
    (config as any).OIDC_ISSUER = 'https://auth.example.com';
    (config as any).SESSION_IDLE_TIMEOUT_MINUTES = 1;
  });

  afterEach(async () => {
    while (cleanups.length > 0) {
      await cleanups.pop()?.();
    }
  });

  it('serves absolute OIDC protected-resource metadata and Bearer challenges over HTTP', async () => {
    const authProvider: AuthProvider = {
      name: 'oidc',
      validateCredential: vi.fn(async () => ({
        userId: 'alice@example.com',
        scopes: ['read', 'write'],
      })),
    };

    const { listener, cleanup } = await startHttpServer(
      {} as never,
      0,
      '/mcp',
      {},
      [],
      'actual-mcp-server',
      'instructions',
      {},
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

    const metadataRes = await fetch(`http://127.0.0.1:${port}/.well-known/oauth-protected-resource`);
    expect(metadataRes.status).toBe(200);
    expect(await metadataRes.json()).toEqual({
      resource: 'https://mcp.example.com/http',
      authorization_servers: ['https://auth.example.com'],
      scopes_supported: ['read', 'write'],
      bearer_methods_supported: ['header'],
      resource_documentation: `http://127.0.0.1:${port}/.well-known/oauth-protected-resource/http`,
    });

    const unauthorizedRes = await fetch(`http://127.0.0.1:${port}/mcp`);
    expect(unauthorizedRes.status).toBe(401);
    expect(unauthorizedRes.headers.get('www-authenticate')).toBe(
      `Bearer error="invalid_token", error_description="Missing Authorization header", scope="read write", resource_metadata="http://127.0.0.1:${port}/.well-known/oauth-protected-resource/http"`,
    );
  });

  it('does not advertise OIDC protected-resource metadata for non-OIDC HTTP auth providers', async () => {
    const authProvider: AuthProvider = {
      name: 'ldap',
      validateCredential: vi.fn(async () => ({ userId: 'alice@example.com' })),
    };

    const { listener, cleanup } = await startHttpServer(
      {} as never,
      0,
      '/mcp',
      {},
      [],
      'actual-mcp-server',
      'instructions',
      {},
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

    const metadataRes = await fetch(`http://127.0.0.1:${port}/.well-known/oauth-protected-resource`);
    expect(metadataRes.status).toBe(404);
  });

  it('enforces legacy static-token auth over HTTP', async () => {
    (config as any).MCP_SSE_AUTHORIZATION = 'test-token';

    const { listener, cleanup } = await startHttpServer(
      {} as never,
      0,
      '/mcp',
      {},
      [],
      'actual-mcp-server',
      'instructions',
      {},
      '0.0.0-test',
      '127.0.0.1',
    );
    await waitForListening(listener);
    const port = (listener.address() as AddressInfo).port;
    cleanups.push(async () => {
      await cleanup();
      await new Promise<void>((resolve, reject) => listener.close((err) => err ? reject(err) : resolve()));
    });

    const missingAuthRes = await fetch(`http://127.0.0.1:${port}/mcp`);
    expect(missingAuthRes.status).toBe(401);
    expect(await missingAuthRes.json()).toEqual({
      error: 'Unauthorized: Missing Authorization header',
    });

    const okRes = await fetch(`http://127.0.0.1:${port}/mcp`, {
      headers: { Authorization: 'Bearer test-token', 'mcp-session-id': 'missing-session' },
    });
    expect(okRes.status).toBe(400);
  });

  it('serves absolute OIDC protected-resource metadata and legacy token auth over SSE', async () => {
    const authProvider: AuthProvider = {
      name: 'oidc',
      validateCredential: vi.fn(async () => ({
        userId: 'alice@example.com',
        scopes: ['read', 'write'],
      })),
    };

    const { httpServer, cleanup } = await startSseServer(
      {} as never,
      0,
      '/sse',
      {},
      [],
      'actual-mcp-server',
      'instructions',
      {},
      '0.0.0-test',
      authProvider,
    );
    await waitForListening(httpServer);
    const port = (httpServer.address() as AddressInfo).port;
    cleanups.push(async () => {
      await cleanup();
      await new Promise<void>((resolve, reject) => httpServer.close((err) => err ? reject(err) : resolve()));
    });

    const metadataRes = await fetch(`http://127.0.0.1:${port}/.well-known/oauth-protected-resource`);
    expect(metadataRes.status).toBe(200);
    expect(await metadataRes.json()).toEqual({
      resource: 'https://mcp.example.com/http',
      authorization_servers: ['https://auth.example.com'],
      scopes_supported: ['read', 'write'],
      bearer_methods_supported: ['header'],
      resource_documentation: `http://127.0.0.1:${port}/.well-known/oauth-protected-resource/sse`,
    });
  });
});
