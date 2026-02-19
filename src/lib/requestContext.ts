import { AsyncLocalStorage } from 'async_hooks';
import type { AuthIdentity } from '../auth/types.js';

export interface RequestContextData {
    sessionId?: string;
    /** Authenticated user identity (present when AUTH_PROVIDER != none). */
    identity?: AuthIdentity;
}

/**
 * AsyncLocalStorage for MCP request context.
 * Provides access to the current sessionId and authenticated identity within tool execution.
 * Populated by the HTTP/SSE server transport handlers and auth middleware.
 */
export const requestContext = new AsyncLocalStorage<RequestContextData>();
