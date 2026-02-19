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

// Mock config with a mutable proxy
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
import { createAuthProvider } from '../../src/auth/auth-factory.js';

function resetConfig() {
  const c = config as Record<string, unknown>;
  Object.keys(c).forEach((k) => delete c[k]);
}

describe('createAuthProvider', () => {
  beforeEach(() => {
    resetConfig();
  });

  it('should return null when AUTH_PROVIDER is "none"', () => {
    (config as any).AUTH_PROVIDER = 'none';
    const provider = createAuthProvider();
    expect(provider).toBeNull();
  });

  it('should return null when AUTH_PROVIDER is not set', () => {
    const provider = createAuthProvider();
    expect(provider).toBeNull();
  });

  it('should return OidcAuthProvider when AUTH_PROVIDER=oidc', () => {
    (config as any).AUTH_PROVIDER = 'oidc';
    (config as any).OIDC_ISSUER = 'https://auth.example.com';
    (config as any).OIDC_CLIENT_ID = 'client-id';
    const provider = createAuthProvider();
    expect(provider).not.toBeNull();
    expect(provider!.name).toBe('oidc');
  });

  it('should throw when OIDC is configured without OIDC_ISSUER', () => {
    (config as any).AUTH_PROVIDER = 'oidc';
    expect(() => createAuthProvider()).toThrow('OIDC_ISSUER');
  });

  it('should return LdapAuthProvider when AUTH_PROVIDER=ldap', () => {
    (config as any).AUTH_PROVIDER = 'ldap';
    (config as any).LDAP_URL = 'ldap://localhost:389';
    (config as any).LDAP_BIND_DN = 'cn=admin,dc=example,dc=com';
    (config as any).LDAP_BIND_PASSWORD = 'secret';
    (config as any).LDAP_SEARCH_BASE = 'ou=users,dc=example,dc=com';
    const provider = createAuthProvider();
    expect(provider).not.toBeNull();
    expect(provider!.name).toBe('ldap');
  });

  it('should throw when LDAP is configured without required settings', () => {
    (config as any).AUTH_PROVIDER = 'ldap';
    (config as any).LDAP_URL = 'ldap://localhost:389';
    // Missing LDAP_BIND_DN, LDAP_BIND_PASSWORD, LDAP_SEARCH_BASE
    expect(() => createAuthProvider()).toThrow('LDAP_BIND_DN');
  });

  it('should throw on unknown AUTH_PROVIDER', () => {
    (config as any).AUTH_PROVIDER = 'saml';
    expect(() => createAuthProvider()).toThrow('Unknown AUTH_PROVIDER: saml');
  });
});
