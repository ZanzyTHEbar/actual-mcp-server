import * as jose from 'jose';
import type { AuthProvider, AuthIdentity } from './types.js';
import logger from '../logger.js';

export interface OidcProviderOptions {
  issuer: string;
  clientId?: string;
  audience?: string;
}

/**
 * OIDC-based auth provider that validates JWT access tokens using
 * the issuer's JWKS (JSON Web Key Set) endpoint discovered via
 * OpenID Connect Discovery.
 */
export class OidcAuthProvider implements AuthProvider {
  readonly name = 'oidc';
  private jwks: jose.JWTVerifyGetKey | null = null;
  private readonly issuer: string;
  private readonly audience: string | undefined;

  constructor(private readonly options: OidcProviderOptions) {
    this.issuer = options.issuer;
    this.audience = options.audience || options.clientId;
  }

  private async getJwks(): Promise<jose.JWTVerifyGetKey> {
    if (!this.jwks) {
      logger.info(`[OIDC] Discovering JWKS from issuer: ${this.issuer}`);
      this.jwks = jose.createRemoteJWKSet(
        new URL(`${this.issuer.replace(/\/$/, '')}/.well-known/jwks.json`),
      );
    }
    return this.jwks;
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

    const identity: AuthIdentity = {
      userId,
      displayName: (payload.name || payload.preferred_username) as string | undefined,
      email: payload.email as string | undefined,
      groups: Array.isArray(payload.groups) ? (payload.groups as string[]) : undefined,
      claims: payload as Record<string, unknown>,
    };

    logger.debug(`[OIDC] Validated token for user: ${userId}`);
    return identity;
  }
}
