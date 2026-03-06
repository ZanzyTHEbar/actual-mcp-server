import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock logger
vi.mock('../../src/logger.js', () => ({
  default: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
}));

// Mock jose — we don't want to call actual JWKS endpoints
const mockJwtVerify = vi.fn();
vi.mock('jose', () => ({
  createRemoteJWKSet: vi.fn().mockReturnValue('mock-jwks'),
  jwtVerify: (...args: unknown[]) => mockJwtVerify(...args),
}));

import { OidcAuthProvider } from '../../src/auth/oidc-provider.js';

describe('OidcAuthProvider', () => {
  let provider: OidcAuthProvider;
  const mockFetch = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubGlobal('fetch', mockFetch);
    mockFetch.mockResolvedValue({
      ok: true,
      json: async () => ({
        issuer: 'https://auth.example.com',
        jwks_uri: 'https://auth.example.com/keys',
      }),
    });
    provider = new OidcAuthProvider({
      issuer: 'https://auth.example.com',
      audience: 'my-audience',
    });
  });

  it('should have name "oidc"', () => {
    expect(provider.name).toBe('oidc');
  });

  it('should validate JWT and return identity with sub claim', async () => {
    mockJwtVerify.mockResolvedValueOnce({
      payload: {
        sub: 'user-123',
        name: 'Alice Smith',
        email: 'alice@example.com',
        groups: ['admin', 'users'],
      },
      protectedHeader: {},
    });

    const identity = await provider.validateCredential('valid-jwt');

    expect(mockJwtVerify).toHaveBeenCalledWith('valid-jwt', 'mock-jwks', {
      issuer: 'https://auth.example.com',
      audience: 'my-audience',
    });
    expect(identity.userId).toBe('user-123');
    expect(identity.displayName).toBe('Alice Smith');
    expect(identity.email).toBe('alice@example.com');
    expect(identity.groups).toEqual(['admin', 'users']);
  });

  it('should fall back to email claim when sub is missing', async () => {
    mockJwtVerify.mockResolvedValueOnce({
      payload: {
        email: 'bob@example.com',
        preferred_username: 'bob',
      },
      protectedHeader: {},
    });

    const identity = await provider.validateCredential('jwt-no-sub');
    expect(identity.userId).toBe('bob@example.com');
  });

  it('should fall back to preferred_username when sub and email are missing', async () => {
    mockJwtVerify.mockResolvedValueOnce({
      payload: {
        preferred_username: 'charlie',
      },
      protectedHeader: {},
    });

    const identity = await provider.validateCredential('jwt-only-username');
    expect(identity.userId).toBe('charlie');
  });

  it('should throw when JWT has no identifying claim', async () => {
    mockJwtVerify.mockResolvedValueOnce({
      payload: { iat: 12345 },
      protectedHeader: {},
    });

    await expect(provider.validateCredential('jwt-no-user'))
      .rejects.toThrow('JWT has no sub, email, or preferred_username claim');
  });

  it('should throw on invalid JWT', async () => {
    mockJwtVerify.mockRejectedValueOnce(new Error('JWS verification failed'));

    await expect(provider.validateCredential('bad-jwt'))
      .rejects.toThrow('JWS verification failed');
  });

  it('should not include groups when not present in claims', async () => {
    mockJwtVerify.mockResolvedValueOnce({
      payload: {
        sub: 'user-456',
        name: 'Dave',
      },
      protectedHeader: {},
    });

    const identity = await provider.validateCredential('jwt-no-groups');
    expect(identity.groups).toBeUndefined();
  });

  it('should use clientId as audience fallback', async () => {
    const p = new OidcAuthProvider({
      issuer: 'https://auth.example.com',
      resource: 'https://mcp.example.com',
    });
    mockJwtVerify.mockResolvedValueOnce({
      payload: { sub: 'test' },
      protectedHeader: {},
    });

    await p.validateCredential('test-token');
    expect(mockJwtVerify).toHaveBeenCalledWith('test-token', 'mock-jwks', {
      issuer: 'https://auth.example.com',
      audience: 'https://mcp.example.com',
    });
  });

  it('fails closed when discovery fails', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: false,
      status: 500,
      json: async () => ({}),
    });

    await expect(provider.validateCredential('test-token')).rejects.toThrow(/OIDC discovery failed/i);
  });
});
