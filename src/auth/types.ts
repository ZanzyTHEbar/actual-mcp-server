/**
 * Authenticated user identity resolved from a token or credential.
 */
export interface AuthIdentity {
  /** Unique user identifier (e.g., email, subject claim, LDAP uid). */
  userId: string;
  /** Human-readable display name, if available. */
  displayName?: string;
  /** Email address, if available. */
  email?: string;
  /** Group memberships, if resolved. */
  groups?: string[];
  /** OAuth/OIDC scopes resolved from the credential, if present. */
  scopes?: string[];
  /** Issuer identifier, when provided by the auth system. */
  issuer?: string;
  /** Raw claims / attributes from the identity provider. */
  claims?: Record<string, unknown>;
}

/**
 * Auth provider interface — implemented by OIDC and LDAP providers.
 */
export interface AuthProvider {
  /** Provider identifier for logging / config. */
  readonly name: string;

  /**
   * Validate a credential (typically a Bearer token) and resolve the user identity.
   * Throws if the credential is invalid or expired.
   */
  validateCredential(credential: string): Promise<AuthIdentity>;

  /**
   * Optional: cleanup resources (e.g., LDAP connection pool).
   */
  shutdown?(): Promise<void>;
}
