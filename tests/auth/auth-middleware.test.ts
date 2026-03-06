import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Request, Response, NextFunction } from 'express';
import type { AuthProvider, AuthIdentity } from '../../src/auth/types.js';

// Mock logger
vi.mock('../../src/logger.js', () => ({
  default: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
}));

import { createAuthMiddleware, getIdentityFromLocals } from '../../src/auth/auth-middleware.js';

function createMockReq(overrides: Partial<Request> = {}): Request {
  return {
    path: '/http',
    ip: '127.0.0.1',
    headers: {},
    ...overrides,
  } as unknown as Request;
}

function createMockRes(): Response & { _statusCode: number; _json: unknown; _headers: Record<string, string> } {
  const res = {
    _statusCode: 200,
    _json: null,
    _headers: {},
    locals: {},
    setHeader(name: string, value: string) {
      res._headers[name] = value;
      return res;
    },
    status(code: number) {
      res._statusCode = code;
      return res;
    },
    json(data: unknown) {
      res._json = data;
      return res;
    },
  } as unknown as Response & { _statusCode: number; _json: unknown; _headers: Record<string, string> };
  return res;
}

describe('Auth Middleware', () => {
  const mockIdentity: AuthIdentity = {
    userId: 'alice@example.com',
    displayName: 'Alice',
    email: 'alice@example.com',
  };

  const mockProvider: AuthProvider = {
    name: 'test',
    validateCredential: vi.fn().mockResolvedValue(mockIdentity),
  };

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('should pass through when provider is null', async () => {
    const middleware = createAuthMiddleware(null);
    const req = createMockReq();
    const res = createMockRes();
    const next = vi.fn();

    await middleware(req, res as any, next as NextFunction);
    expect(next).toHaveBeenCalled();
  });

  it('should skip excluded paths', async () => {
    const middleware = createAuthMiddleware(mockProvider, ['/health', '/metrics']);
    const req = createMockReq({ path: '/health' });
    const res = createMockRes();
    const next = vi.fn();

    await middleware(req, res as any, next as NextFunction);
    expect(next).toHaveBeenCalled();
    expect(mockProvider.validateCredential).not.toHaveBeenCalled();
  });

  it('should reject missing Authorization header', async () => {
    const middleware = createAuthMiddleware(mockProvider);
    const req = createMockReq({ headers: {} });
    const res = createMockRes();
    const next = vi.fn();

    await middleware(req, res as any, next as NextFunction);
    expect(res._statusCode).toBe(401);
    expect(res._headers['WWW-Authenticate']).toBe(
      'Bearer error="invalid_token", error_description="Missing Authorization header"',
    );
    expect(next).not.toHaveBeenCalled();
  });

  it('should reject non-Bearer Authorization header', async () => {
    const middleware = createAuthMiddleware(mockProvider);
    const req = createMockReq({ headers: { authorization: 'Basic abc123' } });
    const res = createMockRes();
    const next = vi.fn();

    await middleware(req, res as any, next as NextFunction);
    expect(res._statusCode).toBe(401);
    expect(res._headers['WWW-Authenticate']).toBe(
      'Bearer error="invalid_token", error_description="Expected Bearer token"',
    );
    expect(next).not.toHaveBeenCalled();
  });

  it('should validate token and attach identity on success', async () => {
    const middleware = createAuthMiddleware(mockProvider);
    const req = createMockReq({ headers: { authorization: 'Bearer valid-token' } });
    const res = createMockRes();
    const next = vi.fn();

    await middleware(req, res as any, next as NextFunction);
    expect(mockProvider.validateCredential).toHaveBeenCalledWith('valid-token');
    expect(res.locals.identity).toEqual(mockIdentity);
    expect(next).toHaveBeenCalled();
  });

  it('should reject with 401 on invalid token', async () => {
    const failProvider: AuthProvider = {
      name: 'test',
      validateCredential: vi.fn().mockRejectedValue(new Error('Token expired')),
    };
    const middleware = createAuthMiddleware(failProvider);
    const req = createMockReq({ headers: { authorization: 'Bearer bad-token' } });
    const res = createMockRes();
    const next = vi.fn();

    await middleware(req, res as any, next as NextFunction);
    expect(res._statusCode).toBe(401);
    expect((res._json as any).error.message).toContain('Token expired');
    expect(res._headers['WWW-Authenticate']).toBe(
      'Bearer error="invalid_token", error_description="Token expired"',
    );
    expect(next).not.toHaveBeenCalled();
  });

  it('should reject with 403 when required scopes are missing', async () => {
    const scopeLimitedProvider: AuthProvider = {
      name: 'oidc',
      validateCredential: vi.fn().mockResolvedValue({
        ...mockIdentity,
        scopes: ['read'],
      }),
    };
    const middleware = createAuthMiddleware(scopeLimitedProvider, ['/health'], {
      requiredScopes: ['write'],
      resourceMetadataUrl: 'https://mcp.example.com/.well-known/oauth-protected-resource/http',
    });
    const req = createMockReq({ headers: { authorization: 'Bearer scope-token' } });
    const res = createMockRes();
    const next = vi.fn();

    await middleware(req, res as any, next as NextFunction);
    expect(res._statusCode).toBe(403);
    expect(res._headers['WWW-Authenticate']).toBe(
      'Bearer error="insufficient_scope", error_description="Missing required scopes: write", scope="write", resource_metadata="https://mcp.example.com/.well-known/oauth-protected-resource/http"',
    );
    expect(next).not.toHaveBeenCalled();
  });
});

describe('getIdentityFromLocals', () => {
  it('should return identity from res.locals', () => {
    const res = { locals: { identity: { userId: 'alice' } } } as unknown as Response;
    expect(getIdentityFromLocals(res)).toEqual({ userId: 'alice' });
  });

  it('should return undefined when no identity', () => {
    const res = { locals: {} } as unknown as Response;
    expect(getIdentityFromLocals(res)).toBeUndefined();
  });
});
