import type { Request, Response, NextFunction } from 'express';
import type { AuthProvider, AuthIdentity } from './types.js';
import logger from '../logger.js';

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
    if (!authHeader) {
      logger.warn(`[Auth] Missing Authorization header from ${req.ip}`);
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
      // Attach identity to response locals for downstream handlers
      res.locals.identity = identity;
      logger.debug(`[Auth] Authenticated user: ${identity.userId}`);
      next();
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      logger.warn(`[Auth] Authentication failed from ${req.ip}: ${message}`);
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
