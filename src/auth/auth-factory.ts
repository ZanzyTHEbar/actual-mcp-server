import type { AuthProvider } from './types.js';
import { OidcAuthProvider } from './oidc-provider.js';
import { LdapAuthProvider } from './ldap-provider.js';
import config from '../config.js';
import logger from '../logger.js';

/**
 * Creates the auth provider based on AUTH_PROVIDER config.
 * Returns null if auth is disabled (AUTH_PROVIDER=none).
 */
export function createAuthProvider(): AuthProvider | null {
  const providerType = config.AUTH_PROVIDER || 'none';

  if (providerType === 'none') {
    logger.info('[Auth] Authentication disabled (AUTH_PROVIDER=none)');
    return null;
  }

  if (providerType === 'oidc') {
    if (!config.OIDC_ISSUER) {
      throw new Error('AUTH_PROVIDER=oidc requires OIDC_ISSUER to be set');
    }
    logger.info(`[Auth] Using OIDC provider (issuer: ${config.OIDC_ISSUER})`);
    return new OidcAuthProvider({
      issuer: config.OIDC_ISSUER,
      clientId: config.OIDC_CLIENT_ID,
      audience: config.OIDC_AUDIENCE,
    });
  }

  if (providerType === 'ldap') {
    if (!config.LDAP_URL || !config.LDAP_BIND_DN || !config.LDAP_BIND_PASSWORD || !config.LDAP_SEARCH_BASE) {
      throw new Error(
        'AUTH_PROVIDER=ldap requires LDAP_URL, LDAP_BIND_DN, LDAP_BIND_PASSWORD, and LDAP_SEARCH_BASE',
      );
    }
    logger.info(`[Auth] Using LDAP provider (url: ${config.LDAP_URL})`);
    return new LdapAuthProvider({
      url: config.LDAP_URL,
      bindDN: config.LDAP_BIND_DN,
      bindPassword: config.LDAP_BIND_PASSWORD,
      searchBase: config.LDAP_SEARCH_BASE,
      searchFilter: config.LDAP_SEARCH_FILTER || '(uid={{username}})',
      groupSearchBase: config.LDAP_GROUP_SEARCH_BASE,
      groupSearchFilter: config.LDAP_GROUP_SEARCH_FILTER || '(member={{dn}})',
    });
  }

  throw new Error(`Unknown AUTH_PROVIDER: ${providerType}. Valid values: none, oidc, ldap`);
}
