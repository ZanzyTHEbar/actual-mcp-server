import type { Request, Response, NextFunction } from 'express';
import type { AuthProvider, AuthIdentity } from './types.js';
import logger from '../logger.js';

type AuthMiddlewareOptions = {
  requiredScopes?: string[];
  resourceMetadataUrl?: string | ((req: Request) => string);
};

function resolveResourceMetadataUrl(
  req: Request,
  resourceMetadataUrl?: string | ((req: Request) => string),
): string | undefined {
  if (!resourceMetadataUrl) return undefined;
  return typeof resourceMetadataUrl === 'function'
    ? resourceMetadataUrl(req)
    : resourceMetadataUrl;
}

function buildWwwAuthenticateValue(opts?: {
  error?: string;
  description?: string;
  requiredScopes?: string[];
  resourceMetadataUrl?: string;
}): string {
  const params: string[] = [];
  if (opts?.error) params.push(`error="${opts.error}"`);
  if (opts?.description) params.push(`error_description="${opts.description.replace(/"/g, "'")}"`);
  if (opts?.requiredScopes && opts.requiredScopes.length > 0) {
    params.push(`scope="${opts.requiredScopes.join(' ')}"`);
  }
  if (opts?.resourceMetadataUrl) {
    params.push(`resource_metadata="${opts.resourceMetadataUrl}"`);
  }
  return params.length > 0 ? `Bearer ${params.join(', ')}` : 'Bearer';
}

/**
 * Creates Express middleware that validates auth credentials and attaches
 * the resolved identity to `res.locals.identity`.
 *
 * When provider is null (AUTH_PROVIDER=none), the middleware is a passthrough.
 *
 * Paths in `excludePaths` skip authentication (e.g., /health, /metrics).
 */
export function createAuthMiddleware(
  provider: AuthProvider | null,
  excludePaths: string[] = ['/health', '/metrics'],
  options?: AuthMiddlewareOptions,
) {
  return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    // Skip excluded paths
    if (excludePaths.some((p) => req.path === p || req.path.startsWith(p + '/'))) {
      return next();
    }

    // No auth provider → passthrough
    if (!provider) {
      return next();
    }

    const authHeader = req.headers.authorization;
    const resourceMetadataUrl = resolveResourceMetadataUrl(req, options?.resourceMetadataUrl);
    if (!authHeader) {
      logger.warn(`[Auth] Missing Authorization header from ${req.ip}`);
      res.setHeader('WWW-Authenticate', buildWwwAuthenticateValue({
        error: 'invalid_token',
        description: 'Missing Authorization header',
        requiredScopes: options?.requiredScopes,
        resourceMetadataUrl,
      }));
      res.status(401).json({
        jsonrpc: '2.0',
        id: null,
        error: { code: -32000, message: 'Unauthorized: Missing Authorization header' },
      });
      return;
    }

    // Extract credential from Bearer token
    const match = authHeader.match(/^Bearer\s+(.+)$/i);
    if (!match) {
      logger.warn(`[Auth] Invalid Authorization header format from ${req.ip}`);
      res.setHeader('WWW-Authenticate', buildWwwAuthenticateValue({
        error: 'invalid_token',
        description: 'Expected Bearer token',
        requiredScopes: options?.requiredScopes,
        resourceMetadataUrl,
      }));
      res.status(401).json({
        jsonrpc: '2.0',
        id: null,
        error: { code: -32000, message: 'Unauthorized: Expected "Bearer <token>"' },
      });
      return;
    }

    const credential = match[1];

    try {
      const identity = await provider.validateCredential(credential);
      if (options?.requiredScopes && options.requiredScopes.length > 0) {
        const granted = new Set(identity.scopes ?? []);
        const missingScopes = options.requiredScopes.filter((scope) => !granted.has(scope));
        if (missingScopes.length > 0) {
          logger.warn(`[Auth] Insufficient scope from ${req.ip}: missing ${missingScopes.join(', ')}`);
          res.setHeader('WWW-Authenticate', buildWwwAuthenticateValue({
            error: 'insufficient_scope',
            description: `Missing required scopes: ${missingScopes.join(', ')}`,
            requiredScopes: options.requiredScopes,
            resourceMetadataUrl,
          }));
          res.status(403).json({
            jsonrpc: '2.0',
            id: null,
            error: { code: -32000, message: `Forbidden: missing required scopes (${missingScopes.join(', ')})` },
          });
          return;
        }
      }
      // Attach identity to response locals for downstream handlers
      res.locals.identity = identity;
      logger.debug(`[Auth] Authenticated user: ${identity.userId}`);
      next();
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      logger.warn(`[Auth] Authentication failed from ${req.ip}: ${message}`);
      res.setHeader('WWW-Authenticate', buildWwwAuthenticateValue({
        error: 'invalid_token',
        description: message,
        requiredScopes: options?.requiredScopes,
        resourceMetadataUrl,
      }));
      res.status(401).json({
        jsonrpc: '2.0',
        id: null,
        error: { code: -32000, message: `Unauthorized: ${message}` },
      });
    }
  };
}

/**
 * Helper to extract the authenticated identity from Express response locals.
 */
export function getIdentityFromLocals(res: Response): AuthIdentity | undefined {
  return res.locals.identity as AuthIdentity | undefined;
}
