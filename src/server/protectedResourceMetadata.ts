import config from '../config.js';
import type { AuthProvider } from '../auth/types.js';

export function buildProtectedResourceMetadata(params: {
  authProvider: AuthProvider | null;
  resourceUrl: string;
  documentationUrl?: string;
}) {
  if (params.authProvider?.name !== 'oidc') {
    return null;
  }

  return {
    resource: config.OIDC_RESOURCE || params.resourceUrl,
    authorization_servers: config.OIDC_ISSUER ? [config.OIDC_ISSUER] : [],
    scopes_supported: config.OIDC_SCOPES ?? [],
    bearer_methods_supported: ['header'],
    ...(params.documentationUrl ? { resource_documentation: params.documentationUrl } : {}),
  };
}
