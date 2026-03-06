import * as jose from 'jose';
import type { AuthProvider, AuthIdentity } from './types.js';
import logger from '../logger.js';

export interface OidcProviderOptions {
  issuer: string;
  clientId?: string;
  audience?: string;
  resource?: string;
  requiredScopes?: string[];
}

/**
 * OIDC-based auth provider that validates JWT access tokens using
 * the issuer's JWKS (JSON Web Key Set) endpoint discovered via
 * OpenID Connect Discovery.
 */
export class OidcAuthProvider implements AuthProvider {
  readonly name = 'oidc';
  private jwks: jose.JWTVerifyGetKey | null = null;
  private discoveryPromise: Promise<{ issuer: string; jwksUri: string }> | null = null;
  private readonly issuer: string;
  private readonly audience: string | undefined;

  constructor(private readonly options: OidcProviderOptions) {
    this.issuer = options.issuer;
    this.audience = options.audience || options.resource;
  }

  private async discoverOidcConfig(): Promise<{ issuer: string; jwksUri: string }> {
    if (!this.discoveryPromise) {
      this.discoveryPromise = (async () => {
        const discoveryUrl = new URL(
          `${this.issuer.replace(/\/$/, '')}/.well-known/openid-configuration`,
        );
        logger.info(`[OIDC] Discovering OIDC configuration from issuer: ${this.issuer}`);
        const response = await fetch(discoveryUrl);
        if (!response.ok) {
          throw new Error(`OIDC discovery failed with status ${response.status}`);
        }
        const metadata = await response.json() as { issuer?: string; jwks_uri?: string };
        if (!metadata.issuer || !metadata.jwks_uri) {
          throw new Error('OIDC discovery response is missing issuer or jwks_uri');
        }
        if (metadata.issuer !== this.issuer) {
          throw new Error(`OIDC discovery issuer mismatch: expected ${this.issuer}, got ${metadata.issuer}`);
        }
        return { issuer: metadata.issuer, jwksUri: metadata.jwks_uri };
      })();
    }
    return this.discoveryPromise;
  }

  private async getJwks(): Promise<jose.JWTVerifyGetKey> {
    if (!this.jwks) {
      const discovery = await this.discoverOidcConfig();
      this.jwks = jose.createRemoteJWKSet(new URL(discovery.jwksUri));
    }
    return this.jwks;
  }

  private extractScopes(payload: jose.JWTPayload): string[] {
    const scopes = new Set<string>();
    const scopeClaim = payload.scope;
    if (typeof scopeClaim === 'string') {
      for (const scope of scopeClaim.split(/\s+/).filter(Boolean)) scopes.add(scope);
    }
    const scpClaim = payload.scp;
    if (Array.isArray(scpClaim)) {
      for (const scope of scpClaim.filter((item): item is string => typeof item === 'string')) {
        scopes.add(scope);
      }
    }
    return [...scopes];
  }

  async validateCredential(token: string): Promise<AuthIdentity> {
    const jwks = await this.getJwks();

    const verifyOptions: jose.JWTVerifyOptions = {
      issuer: this.issuer,
    };

    if (this.audience) {
      verifyOptions.audience = this.audience;
    }

    const { payload } = await jose.jwtVerify(token, jwks, verifyOptions);

    // Extract identity from standard OIDC claims
    const userId = (payload.sub || payload.email || payload.preferred_username) as string;
    if (!userId) {
      throw new Error('JWT has no sub, email, or preferred_username claim');
    }

    const scopes = this.extractScopes(payload);
    const identity: AuthIdentity = {
      userId,
      displayName: (payload.name || payload.preferred_username) as string | undefined,
      email: payload.email as string | undefined,
      groups: Array.isArray(payload.groups) ? (payload.groups as string[]) : undefined,
      scopes,
      issuer: this.issuer,
      claims: payload as Record<string, unknown>,
    };

    logger.debug(`[OIDC] Validated token for user: ${userId}`);
    return identity;
  }
}
