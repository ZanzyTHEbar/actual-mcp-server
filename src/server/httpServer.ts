// src/server/httpServer.ts
import type { ActualMCPConnection } from '../lib/ActualMCPConnection.ts';
import express, { Request, Response } from 'express';
import { randomUUID } from 'crypto';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import {
  ListToolsRequestSchema,
  CallToolRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import logger, { sanitizeForLog, sanitizeError } from '../logger.js';
import { getLocalIp } from '../utils.js';
import actualToolsManager from '../actualToolsManager.js';
import { sessionWorkerManager } from '../lib/SessionWorkerManager.js';
import { ensureCallToolResult, toTextResult } from '../lib/toolResult.js';
import observability from '../observability.js';
import config from '../config.js';
import { requestContext } from '../lib/requestContext.js';
import type { AuthProvider, AuthIdentity } from '../auth/types.js';
import { createAuthMiddleware, getIdentityFromLocals } from '../auth/auth-middleware.js';

// Re-export for backward compatibility
export { requestContext };

export async function startHttpServer(
  mcp: ActualMCPConnection,
  port: number,
  httpPath: string,
  capabilities: Record<string, object>,          // was passed by index.ts
  implementedTools: string[],                    // was passed by index.ts
  serverDescription: string,                     // was passed by index.ts
  serverInstructions: string,                    // was passed by index.ts
  toolSchemas: Record<string, unknown>,              // was passed by index.ts
  version: string,                               // server version from package.json
  bindHost = 'localhost',
  advertisedUrl?: string,
  authProvider?: AuthProvider | null,
) {
  const app = express();
  app.use(express.json());

  // Mount OIDC/LDAP auth middleware if a provider is configured.
  // When authProvider is active, it replaces the legacy MCP_SSE_AUTHORIZATION check.
  const resolvedAuthProvider = authProvider ?? null;
  if (resolvedAuthProvider) {
    app.use(createAuthMiddleware(resolvedAuthProvider, ['/health', '/metrics', '/.well-known']));
    logger.info(`[Auth] ${resolvedAuthProvider.name.toUpperCase()} auth middleware mounted`);
  }

  // Map session → authenticated identity
  const sessionIdentities = new Map<string, AuthIdentity>();

  const transports = new Map<string, StreamableHTTPServerTransport>();
  const sessionLastActivity = new Map<string, number>();
  const sessionInitPromises = new Map<string, Promise<void>>();  // Track session init completion
  // Use same timeout as config (SESSION_IDLE_TIMEOUT_MINUTES, default: 10 minutes)
  const idleTimeoutMinutes = config.SESSION_IDLE_TIMEOUT_MINUTES || 10;
  const SESSION_TIMEOUT_MS = idleTimeoutMinutes * 60 * 1000;
  const SESSION_CLEANUP_INTERVAL_MS = 30 * 1000; // Check every 30 seconds

  // safe fallback if index didn't provide implementedTools
  const toolsList: string[] = Array.isArray(implementedTools) ? implementedTools : [];

  // Session cleanup: check for idle sessions periodically
  const cleanupInterval = setInterval(async () => {
    const now = Date.now();
    const sessionsToCleanup: string[] = [];

    for (const [sessionId, lastActivity] of sessionLastActivity.entries()) {
      if (now - lastActivity > SESSION_TIMEOUT_MS) {
        sessionsToCleanup.push(sessionId);
      }
    }

    for (const sessionId of sessionsToCleanup) {
      logger.info(`[SESSION] Cleaning up idle session: ${sessionId}`);
      transports.delete(sessionId);
      sessionLastActivity.delete(sessionId);
      sessionInitPromises.delete(sessionId);
      sessionIdentities.delete(sessionId);
      await sessionWorkerManager.closeSession(sessionId);
    }
  }, SESSION_CLEANUP_INTERVAL_MS);

  // Legacy authentication (MCP_SSE_AUTHORIZATION static token).
  // Only used when no real auth provider is configured.
  const authenticateRequest = (req: Request, res: Response): boolean => {
    // If a real auth provider is mounted, it already handled auth via middleware
    if (resolvedAuthProvider) return true;

    // If MCP_SSE_AUTHORIZATION is not configured, allow all requests
    if (!config.MCP_SSE_AUTHORIZATION) {
      return true;
    }

    const authHeader = req.headers.authorization;
    if (!authHeader) {
      logger.warn(`[HTTP] Unauthorized request from ${req.ip || req.connection.remoteAddress}: Missing Authorization header`);
      res.status(401).json({ error: 'Unauthorized: Missing Authorization header' });
      return false;
    }

    // Check for Bearer token format
    const match = authHeader.match(/^Bearer\s+(.+)$/i);
    if (!match) {
      logger.warn(`[HTTP] Unauthorized request from ${req.ip || req.connection.remoteAddress}: Invalid Authorization header format`);
      res.status(401).json({ error: 'Unauthorized: Invalid Authorization header format. Expected "Bearer <token>"' });
      return false;
    }

    const token = match[1];

    if (token !== config.MCP_SSE_AUTHORIZATION) {
      logger.warn(`[HTTP] Unauthorized request from ${req.ip || req.connection.remoteAddress}: Invalid token`);
      res.status(401).json({ error: 'Unauthorized: Invalid token' });
      return false;
    }

    return true;
  };

  // Create a fresh Server instance similar to httpServer_testing
  function createServerInstance() {
    // ensure capabilities.tools is an object mapping tool name -> {}
    const capabilitiesObj = capabilities && Object.keys(capabilities).length
      ? capabilities
      : { tools: toolsList.reduce((acc: Record<string, object>, n: string) => { acc[n] = {}; return acc; }, {}) };

    const serverOptions: Record<string, unknown> = {
      // Provide instructions and capabilities so the SDK initialize response is correct
      instructions: serverInstructions || "Welcome to the Actual MCP server.",
      serverInstructions: { instructions: serverInstructions || "Welcome to the Actual MCP server." },
      capabilities: capabilitiesObj,
      implementedTools: toolsList,
      // Include tools array explicitly so initialize result contains tools: string[]
      tools: toolsList,
    };

    const server = new Server(
      {
        name: serverDescription || "actual-mcp-server",
        version: version || "0.1.0",
      },
      serverOptions
    );

    // List tools handler
    server.setRequestHandler(ListToolsRequestSchema, async () => {
      logger.debug('[TOOLS LIST] Listing available tools');
      logger.debug(`[TOOLS LIST] toolsList length: ${toolsList.length}`);
      const tools = toolsList.map((name: string) => {
        const schemaFromParam = toolSchemas && toolSchemas[name];
        const schemaFromManager = (actualToolsManager as unknown as { getToolSchema?: (n: string) => unknown })?.getToolSchema?.(name);
        const schema = schemaFromParam || schemaFromManager;

        // Ensure inputSchema is a valid JSON Schema object with required properties
        const inputSchema = schema && typeof schema === 'object' && Object.keys(schema).length > 0
          ? schema
          : { type: 'object', properties: {}, additionalProperties: false };

        // Get the actual tool description from the tool definition
        const tool = actualToolsManager.getTool(name);
        const description = tool?.description || `Tool ${name}`;

        return {
          name,
          description,
          inputSchema,
        };
      });
      logger.debug(`[TOOLS LIST] Returning ${tools.length} tools`);
      return { tools };
    });

    // Call tool handler -> proxy to mcp.executeTool or to actualToolsManager
    // Note: sessionId is available via requestContext.getStore() for tools that need it
    server.setRequestHandler(CallToolRequestSchema, async (request: unknown) => {
      const req = request as { params?: Record<string, unknown> } | undefined;
      const params = req?.params ?? {};
      const rawName = params.name;
      const args = params.arguments;
      if (typeof rawName !== 'string') {
        throw new Error('Tool name must be a string');
      }
      const name = rawName;
      logger.debug(`[TOOL CALL] ${name} args=${JSON.stringify(sanitizeForLog(args))}`);
      // Prefer ActualMCPConnection executor if provided
      const context = requestContext.getStore();
      const sessionId = context?.sessionId;

      if (!sessionId) {
        throw new Error('Session id not available for tool execution');
      }

      if (name === 'actual_session_list') {
        const stats = sessionWorkerManager.getStats();
        return toTextResult(stats);
      }

      if (name === 'actual_tool_call') {
        const result = await actualToolsManager.callTool(name, args ?? {});
        return ensureCallToolResult(result);
      }

      if (name === 'actual_session_close') {
        const input = (args || {}) as { sessionId?: string };
        const stats = sessionWorkerManager.getStats();
        if (stats.totalSessions === 0) {
          return toTextResult({ success: false, message: 'No sessions to close' });
        }

        let targetSessionId: string | null = null;
        if (input.sessionId) {
          const matches = stats.sessions.filter((s) => s.sessionId.toLowerCase().includes(input.sessionId!.toLowerCase()));
          if (matches.length === 0) {
            return toTextResult({ success: false, message: `No session found matching "${input.sessionId}"`, availableSessions: stats.sessions.map((s) => s.sessionId) });
          }
          if (matches.length > 1) {
            return toTextResult({ success: false, message: `Multiple sessions match "${input.sessionId}". Please be more specific.`, matchingSessions: matches.map((s) => s.sessionId) });
          }
          targetSessionId = matches[0].sessionId;
        } else {
          const sorted = [...stats.sessions]
            .filter((s) => s.sessionId !== sessionId)
            .sort((a, b) => b.idleMinutes - a.idleMinutes);
          if (sorted.length === 0) {
            return toTextResult({ success: false, message: 'No other sessions to close (only your current session is active)' });
          }
          targetSessionId = sorted[0].sessionId;
        }

        if (targetSessionId === sessionId) {
          return toTextResult({ success: false, message: 'Cannot close your current session. Please specify a different session.' });
        }

        await sessionWorkerManager.closeSession(targetSessionId);
        const newStats = sessionWorkerManager.getStats();
        return toTextResult({
          success: true,
          message: `Session ${targetSessionId} closed successfully`,
          closedSession: targetSessionId,
          remainingSessions: newStats.totalSessions,
          maxConcurrent: newStats.maxConcurrent,
          availableSlots: newStats.maxConcurrent - newStats.activeSessions,
        });
      }

      return await sessionWorkerManager.executeTool(sessionId, name, args ?? {});
    });

    return { server };
  }

  // Middleware to inject Accept header for LobeChat compatibility
  // Must be before the route handler
  app.use(httpPath, (req: Request, _res: Response, next: () => void) => {
    const accept = req.get('Accept');
    logger.debug(`[ACCEPT HEADER MIDDLEWARE] Original: ${accept || 'undefined'}`);
    // Fix Accept header if it's missing, */* , or doesn't include BOTH required types
    const needsFix = !accept ||
      accept === '*/*' ||
      !accept.includes('application/json') ||
      !accept.includes('text/event-stream');
    if (needsFix) {
      logger.debug('[ACCEPT HEADER MIDDLEWARE] Modifying Accept header for MCP SDK compatibility');
      // Use setHeader to properly modify the request headers
      req.headers.accept = 'application/json, text/event-stream';
      // Also try modifying the raw headers object
      if (req.rawHeaders) {
        const acceptIndex = req.rawHeaders.findIndex((h: string) => h.toLowerCase() === 'accept');
        if (acceptIndex >= 0 && acceptIndex + 1 < req.rawHeaders.length) {
          req.rawHeaders[acceptIndex + 1] = 'application/json, text/event-stream';
        }
      }
    }
    next();
  });

  // Unified POST handler. Create new server/transport only on initialize (no session id).
  app.post(httpPath, async (req: Request, res: Response) => {
    // Authenticate the request
    if (!authenticateRequest(req, res)) {
      return;
    }

    const sessionId = req.headers['mcp-session-id'] as string | undefined;
    const payload = (req.body && Object.keys(req.body).length) ? req.body : {};
    const method = payload?.method;

    // Special handling for tools/list without session (LobeChat compatibility)
    // LobeChat sends Accept: */* or Accept: application/json which the MCP SDK rejects
    // Handle this case directly without going through the transport
    if (!sessionId && method === 'tools/list') {
      logger.debug('[LOBECHAT COMPAT] Handling tools/list without session directly');
      const tools = toolsList.map((name: string) => {
        const schemaFromParam = toolSchemas && toolSchemas[name];
        const schemaFromManager = (actualToolsManager as unknown as { getToolSchema?: (n: string) => unknown })?.getToolSchema?.(name);
        const schema = schemaFromParam || schemaFromManager;

        // Ensure inputSchema is a valid JSON Schema object with required properties
        const inputSchema = schema && typeof schema === 'object' && Object.keys(schema).length > 0
          ? schema
          : { type: 'object', properties: {}, additionalProperties: false };

        // Get the actual tool description from the tool definition
        const tool = actualToolsManager.getTool(name);
        const description = tool?.description || `Tool ${name}`;

        return {
          name,
          description,
          inputSchema,
        };
      });

      res.json({
        jsonrpc: '2.0',
        id: payload?.id ?? null,
        result: { tools }
      });
      return;
    }

    try {
      if (!sessionId) {
        // Allow initialize or tools/list without session id (LobeChat compatibility)
        // For tools/list, we'll auto-create a session
        if (method !== 'initialize' && method !== 'tools/list') {
          res.status(400).json({
            jsonrpc: '2.0',
            id: payload?.id ?? null,
            error: { code: -32000, message: 'Missing session id; only initialize or tools/list allowed without session' },
          });
          return;
        }

        // Check if we can accept a new session (concurrent limit)
        if (!sessionWorkerManager.canAcceptNewSession()) {
          const stats = sessionWorkerManager.getStats();
          const timeoutMinutes = idleTimeoutMinutes || 2;
          const errorMsg = `Max concurrent sessions (${stats?.maxConcurrent}) reached. Active: ${stats?.activeSessions}. Please close existing sessions or wait for idle sessions to timeout (${timeoutMinutes} minutes).`;
          logger.warn(`[SESSION] Rejecting new session: ${errorMsg}`);
          res.status(503).json({
            jsonrpc: '2.0',
            id: payload?.id ?? null,
            error: {
              code: -32000,
              message: errorMsg,
              data: {
                maxConcurrent: stats?.maxConcurrent,
                activeSessions: stats?.activeSessions,
                availableSlots: (stats?.maxConcurrent ?? 0) - (stats?.activeSessions ?? 0),
                idleTimeoutMinutes: timeoutMinutes
              }
            },
          });
          return;
        }

        logger.debug('[SESSION] Creating new MCP server + transport for initialize');
        const { server } = createServerInstance();

        // Create a promise to track session initialization completion
        let resolveInit: (() => void) | undefined;
        let rejectInit: ((err: unknown) => void) | undefined;
        const initPromise = new Promise<void>((resolve, reject) => {
          resolveInit = resolve;
          rejectInit = reject;
        });

        // Capture identity from auth middleware (if auth is active)
        const initIdentity = getIdentityFromLocals(res);

        const transport = new StreamableHTTPServerTransport({
          sessionIdGenerator: () => randomUUID(),
          enableJsonResponse: true,
          onsessioninitialized: async (sid: string) => {
            logger.debug(`Session initialized: ${sid}`);
            // Store the promise before starting initialization
            sessionInitPromises.set(sid, initPromise);

            // Bind identity to session (if authenticated)
            if (initIdentity) {
              sessionIdentities.set(sid, initIdentity);
              logger.info(`[SESSION] Bound identity ${initIdentity.userId} to session ${sid}`);
            }

            // Initialize connection pool for this session
            try {
              await sessionWorkerManager.createSession(sid);
              // Only add to transports/activity map if worker session initialized
              transports.set(sid, transport);
              sessionLastActivity.set(sid, Date.now());
              logger.info(`[SESSION] Worker session initialized for session: ${sid}`);
              resolveInit?.();
            } catch (err) {
              logger.error(`[SESSION] Failed to initialize worker for session ${sid}: ${sanitizeError(err).message}`);
              rejectInit?.(err);
            } finally {
              // Clean up the promise after a short delay to allow pending requests to complete
              setTimeout(() => sessionInitPromises.delete(sid), 1000);
            }
          },
        });

        // connect transport then handle request (matching working example)
        await server.connect(transport);
        try {
          // Run in AsyncLocalStorage context so tools can access sessionId + identity
          await requestContext.run({ sessionId: undefined, identity: initIdentity }, async () => {
            await transport.handleRequest(req, res, req.body);
          });
        } catch (err: unknown) {
          const initErr = sanitizeError(err);
          logger.error('Transport.handleRequest failed during initialize: %s', initErr.message);
          if (initErr.stack) logger.error(initErr.stack);
          throw err;
        }
        return;
      }

      // sessionId present -> reuse
      let transport = transports.get(sessionId);
      if (!transport) {
        // Check if session is currently being initialized
        const initPromise = sessionInitPromises.get(sessionId);
        if (initPromise) {
          logger.debug(`[SESSION] Waiting for session ${sessionId} initialization to complete...`);
          try {
            // Wait for initialization to complete
            await initPromise;
            transport = transports.get(sessionId);
            if (transport) {
              logger.debug(`[SESSION] Session ${sessionId} initialization complete, proceeding with request`);
            }
          } catch (err) {
            logger.error(`[SESSION] Session ${sessionId} initialization failed: ${sanitizeError(err).message}`);
            // Fall through to session not found handling
          }
        }

        if (!transport) {
          // Session doesn't exist (expired, server restarted, or invalid)
          // For tools/list, return tools for LobeChat discovery (they cache session IDs)
          // This allows LobeChat's backend to discover available tools even with expired sessions
          if (method === 'tools/list') {
            logger.debug('[LOBECHAT COMPAT] Handling tools/list with expired/invalid session - returning tools for discovery');
            const tools = toolsList.map((name: string) => {
              const schemaFromParam = toolSchemas && toolSchemas[name];
              const schemaFromManager = (actualToolsManager as unknown as { getToolSchema?: (n: string) => unknown })?.getToolSchema?.(name);
              const schema = schemaFromParam || schemaFromManager;

              const inputSchema = schema && typeof schema === 'object' && Object.keys(schema).length > 0
                ? schema
                : { type: 'object', properties: {}, additionalProperties: false };

              const tool = actualToolsManager.getTool(name);
              const description = tool?.description || `Tool ${name}`;

              return {
                name,
                description,
                inputSchema,
              };
            });

            res.json({
              jsonrpc: '2.0',
              id: payload?.id ?? null,
              result: { tools }
            });
            return;
          }

          // For other methods, reject the request and tell client to re-initialize
          logger.warn(`[SESSION] Session ${sessionId} not found (method: ${method}). Client must re-initialize.`);
          res.status(400).json({
            jsonrpc: '2.0',
            id: payload?.id ?? null,
            error: {
              code: -32000,
              message: 'Session expired or invalid. Please re-initialize by calling initialize without mcp-session-id header.'
            },
          });
          return;
        }
      }

      // Update activity timestamp for valid session
      sessionLastActivity.set(sessionId, Date.now());

      // Resolve identity: from current request auth or from session binding
      const reqIdentity = getIdentityFromLocals(res) || sessionIdentities.get(sessionId);

      // If auth is active, enforce session-identity binding (one user per session)
      if (resolvedAuthProvider && reqIdentity && sessionIdentities.has(sessionId)) {
        const boundIdentity = sessionIdentities.get(sessionId)!;
        if (boundIdentity.userId !== reqIdentity.userId) {
          logger.warn(`[Auth] Identity mismatch: session bound to ${boundIdentity.userId}, request from ${reqIdentity.userId}`);
          res.status(403).json({
            jsonrpc: '2.0',
            id: payload?.id ?? null,
            error: { code: -32000, message: 'Forbidden: session belongs to a different user' },
          });
          return;
        }
      }

      // Run in AsyncLocalStorage context so tools can access sessionId + identity
      await requestContext.run({ sessionId, identity: reqIdentity }, async () => {
        await transport.handleRequest(req, res, req.body);
      });
    } catch (err: unknown) {
      const sanitized = sanitizeError(err);
      logger.error('POST handler error: %s', sanitized.message);
      if (sanitized.stack) logger.error(sanitized.stack);
      if (!res.headersSent) {
        res.status(500).json({ jsonrpc: '2.0', id: payload?.id ?? null, error: { code: -32603, message: String(err) } });
      }
    }
  });

  // GET for SSE connect (reuse transport)
  app.get(httpPath, async (req: Request, res: Response) => {
    const sessionId = req.headers['mcp-session-id'] as string | undefined;
    if (!sessionId) {
      res.status(400).json({ jsonrpc: '2.0', error: { code: -32000, message: 'No session id' }, id: null });
      return;
    }
    sessionLastActivity.set(sessionId, Date.now()); // Track activity
    const transport = transports.get(sessionId);
    if (!transport) {
      res.status(400).json({ jsonrpc: '2.0', error: { code: -32000, message: 'Transport not ready' }, id: null });
      return;
    }
    await transport.handleRequest(req, res);
  });

  // quick GET info endpoints (some clients probe)
  const serverIp = process.env.MCP_BRIDGE_PUBLIC_HOST || getLocalIp();
  app.get('/.well-known/oauth-protected-resource', (_req, res) => {
    res.json({
      jsonrpc: '2.0',
      result: {
        description: serverDescription || "Actual MCP server",
        instructions: serverInstructions || "Welcome to the Actual MCP server.",
        serverInstructions: { instructions: serverInstructions || "Welcome to the Actual MCP server." },
        capabilities: capabilities && Object.keys(capabilities).length ? capabilities : { tools: toolsList.reduce((a: Record<string, object>, n: string) => ({ ...a, [n]: {} }), {}) },
        tools: toolsList,
        advertisedUrl: advertisedUrl || `http://${serverIp}:${port}${httpPath}`,
      },
    });
  });

  app.get('/.well-known/oauth-protected-resource/http', (_req, res) => {
    res.json({
      jsonrpc: '2.0',
      result: {
        description: serverDescription || "Actual MCP server",
        instructions: serverInstructions || "Welcome to the Actual MCP server.",
        serverInstructions: { instructions: serverInstructions || "Welcome to the Actual MCP server." },
        capabilities: capabilities && Object.keys(capabilities).length ? capabilities : { tools: toolsList.reduce((a: Record<string, object>, n: string) => ({ ...a, [n]: {} }), {}) },
        tools: toolsList,
        advertisedUrl: advertisedUrl || `http://${serverIp}:${port}${httpPath}`,
      },
    });
  });

  app.get('/health', (_req, res) => {
    const stats = sessionWorkerManager.getStats();
    res.json({
      status: 'ok',
      ...stats,
      transport: 'streamable-http',
      activeSessions: transports.size,
    });
  });

  app.get('/metrics', async (_req, res) => {
    const txt = await observability.getMetricsText();
    if (!txt) {
      res.status(204).end();
      return;
    }
    res.setHeader('Content-Type', 'text/plain; version=0.0.4');
    res.send(txt);
  });

  const listener = app.listen(port, () => {
    const advertised = advertisedUrl || `http://${serverIp}:${port}${httpPath}`;
    console.info(`MCP Streamable HTTP Server listening on ${port}`);
    console.info(`📨 MCP endpoint: ${advertised}`);
    console.info(`❤️ Health check: http://localhost:${port}/health`);
    if (resolvedAuthProvider) {
      logger.info(`🔒 Authentication enabled (provider: ${resolvedAuthProvider.name})`);
    } else if (config.MCP_SSE_AUTHORIZATION) {
      logger.info(`🔒 HTTP authentication enabled (Bearer token required)`);
    } else {
      logger.warn(`⚠️  HTTP authentication disabled (no MCP_SSE_AUTHORIZATION set)`);
    }
  });

  // Configure keep-alive to maintain persistent connections
  listener.keepAliveTimeout = 65000; // 65 seconds (slightly higher than typical client timeout)
  listener.headersTimeout = 66000;   // 66 seconds (must be higher than keepAliveTimeout)
  logger.info(`⏱️  HTTP keep-alive enabled (timeout: ${listener.keepAliveTimeout}ms)`);

  // Cleanup on server shutdown
  const cleanup = async () => {
    logger.info('[SERVER] Shutting down, cleaning up sessions...');
    clearInterval(cleanupInterval);
    for (const sessionId of transports.keys()) {
      await sessionWorkerManager.closeSession(sessionId);
    }
    transports.clear();
    sessionLastActivity.clear();
    sessionInitPromises.clear();
    sessionIdentities.clear();
  };

  process.on('SIGTERM', cleanup);
  process.on('SIGINT', cleanup);

  return { app, listener, cleanup };
}
