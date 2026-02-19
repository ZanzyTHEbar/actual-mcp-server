// src/server/sseServer.ts
import type { ActualMCPConnection } from '../lib/ActualMCPConnection.ts';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { SSEServerTransport } from '@modelcontextprotocol/sdk/server/sse.js';
import express from 'express';
import { createServer } from 'http';
import type { Request, Response } from 'express';
import logger from '../logger.js';
import actualToolsManager from '../actualToolsManager.js';
import { ListToolsRequestSchema, CallToolRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import config from '../config.js';
import { sessionWorkerManager } from '../lib/SessionWorkerManager.js';
import { toTextResult } from '../lib/toolResult.js';
import type { AuthProvider, AuthIdentity } from '../auth/types.js';
import { createAuthMiddleware, getIdentityFromLocals } from '../auth/auth-middleware.js';
import { requestContext } from '../lib/requestContext.js';

export async function startSseServer(
  mcp: ActualMCPConnection,
  port: number,
  ssePath: string,
  capabilities: Record<string, object>,
  implementedTools: string[],
  serverDescription: string,
  serverInstructions: string,
  toolSchemas: Record<string, unknown>,
  version: string,
  authProvider?: AuthProvider | null,
) {
  const app = express();
  const httpServer = createServer(app);

  app.use(express.json());

  const resolvedAuthProvider = authProvider ?? null;
  if (resolvedAuthProvider) {
    app.use(createAuthMiddleware(resolvedAuthProvider, ['/health', '/metrics']));
    logger.info(`[SSE Auth] ${resolvedAuthProvider.name.toUpperCase()} auth middleware mounted`);
  }

  const sessionIdentities = new Map<string, AuthIdentity>();

  app.use((req, res, next) => {
    logger.debug(`HTTP ${req.method} ${req.originalUrl} from ${req.ip || req.connection.remoteAddress}`);
    next();
  });

  // Store transports by session ID
  const transports: Record<string, SSEServerTransport> = {};

  // safe fallback if index didn't provide implementedTools
  const toolsList: string[] = Array.isArray(implementedTools) ? implementedTools : [];

  const authenticateRequest = (req: Request, res: Response): boolean => {
    if (resolvedAuthProvider) return true;
    if (!config.MCP_SSE_AUTHORIZATION) {
      return true;
    }

    const authHeader = req.headers.authorization;
    if (!authHeader) {
      logger.warn(`[SSE] Unauthorized request from ${req.ip || req.connection.remoteAddress}: Missing Authorization header`);
      res.status(401).json({ error: 'Unauthorized: Missing Authorization header' });
      return false;
    }

    // Check for Bearer token format
    const match = authHeader.match(/^Bearer\s+(.+)$/i);
    if (!match) {
      logger.warn(`[SSE] Unauthorized request from ${req.ip || req.connection.remoteAddress}: Invalid Authorization header format`);
      res.status(401).json({ error: 'Unauthorized: Invalid Authorization header format. Expected "Bearer <token>"' });
      return false;
    }

    const token = match[1];
    if (token !== config.MCP_SSE_AUTHORIZATION) {
      logger.warn(`[SSE] Unauthorized request from ${req.ip || req.connection.remoteAddress}: Invalid token`);
      res.status(401).json({ error: 'Unauthorized: Invalid token' });
      return false;
    }

    return true;
  };

  // Function to create and configure MCP server for each client
  const createMcpServer = (sessionId: string) => {
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
        name: serverDescription || 'actual-mcp-server',
        version: version || '0.1.0',
      },
      serverOptions
    );

    // Set up tools/list handler
    server.setRequestHandler(ListToolsRequestSchema, async () => {
      logger.debug('[SSE] Listing available tools');
      const tools = toolsList.map((name: string) => {
        const schemaFromParam = toolSchemas && toolSchemas[name];
        const schemaFromManager = (actualToolsManager as unknown as { getToolSchema?: (n: string) => unknown })?.getToolSchema?.(name);
        const schema = schemaFromParam || schemaFromManager;
        
        // Ensure inputSchema is a valid JSON Schema object with required properties
        const inputSchema = schema && typeof schema === 'object' && Object.keys(schema).length > 0
          ? schema
          : { type: 'object', properties: {}, additionalProperties: false };
        
        // Get the actual tool definition to extract the real description
        const tool = actualToolsManager.getTool(name);
        const description = tool?.description || `Tool ${name}`;
        
        return {
          name,
          description,
          inputSchema,
        };
      });
      return { tools };
    });

    // Set up tools/call handler
    server.setRequestHandler(CallToolRequestSchema, async (request: any) => {
      const { name, arguments: args } = request.params;
      logger.debug(`[SSE] Tool call: ${name}`);
      try {
        if (name === 'actual_session_list') {
          const stats = sessionWorkerManager.getStats();
          return toTextResult(stats);
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
              return toTextResult({ success: false, message: `No session found matching \"${input.sessionId}\"`, availableSessions: stats.sessions.map((s) => s.sessionId) });
            }
            if (matches.length > 1) {
              return toTextResult({ success: false, message: `Multiple sessions match \"${input.sessionId}\". Please be more specific.`, matchingSessions: matches.map((s) => s.sessionId) });
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
        return await sessionWorkerManager.executeTool(sessionId, name, args || {});
      } catch (error: any) {
        logger.error(`[SSE] Tool error for ${name}:`, error);
        throw error;
      }
    });

    return server;
  };

  // SSE endpoint for establishing the stream
  app.get(ssePath, async (req: Request, res: Response) => {
    const clientIp = req.ip || req.connection.remoteAddress || 'unknown IP';
    
    // Authenticate the request
    if (!authenticateRequest(req, res)) {
      return;
    }
    
    logger.info(`⚡ SSE client connected from ${clientIp}`);

    try {
      if (!sessionWorkerManager.canAcceptNewSession()) {
        logger.warn(`[SSE] Rejecting new session: max concurrent sessions reached`);
        res.status(503).json({ error: 'Max concurrent sessions reached. Please close existing sessions.' });
        return;
      }

      // Create SSE transport - the POST endpoint will be ssePath (same path)
      const transport = new SSEServerTransport(ssePath, res);
      const sessionId = transport.sessionId;
      
      const initIdentity = getIdentityFromLocals(res);
      if (initIdentity) {
        sessionIdentities.set(sessionId, initIdentity);
        logger.info(`[SSE] Bound identity ${initIdentity.userId} to session ${sessionId}`);
      }
      
      transports[sessionId] = transport;

      await sessionWorkerManager.createSession(sessionId);

      const KEEPALIVE_INTERVAL_MS = 30_000;
      const keepaliveTimer = setInterval(() => {
        try {
          if (!res.writableEnded && !res.destroyed) {
            res.write(': keepalive\n\n');
            sessionWorkerManager.touchSession(sessionId);
          }
        } catch {
          // ignore write errors (e.g. client disconnected)
        }
      }, KEEPALIVE_INTERVAL_MS);

      transport.onclose = async () => {
        clearInterval(keepaliveTimer);
        logger.info(`❌ SSE client disconnected (session: ${sessionId}) from ${clientIp}`);
        delete transports[sessionId];
        sessionIdentities.delete(sessionId);
        await sessionWorkerManager.closeSession(sessionId);
      };

      // Create and connect MCP server
      const mcpServer = createMcpServer(sessionId);
      await mcpServer.connect(transport);
      
      logger.info(`[SSE] MCP server connected for client ${clientIp} (session: ${sessionId})`);
    } catch (error) {
      logger.error(`[SSE] Error establishing connection from ${clientIp}:`, error);
      res.status(500).end();
    }
  });

  // HEAD endpoint for checking endpoint availability
  app.head(ssePath, (req: Request, res: Response) => {
    // Authenticate the request
    if (!authenticateRequest(req, res)) {
      return;
    }
    
    // Return 200 OK with appropriate headers
    res.status(200).end();
  });

  // POST endpoint for receiving client messages
  app.post(ssePath, async (req: Request, res: Response) => {
    const clientIp = req.ip || req.connection.remoteAddress || 'unknown IP';
    
    // Authenticate the request
    if (!authenticateRequest(req, res)) {
      return;
    }
    
    const sessionId = req.query.sessionId as string;
    
    if (!sessionId) {
      logger.warn(`[SSE] POST without sessionId from ${clientIp}`);
      res.status(400).json({ error: 'Missing sessionId query parameter' });
      return;
    }

    const transport = transports[sessionId];
    if (!transport) {
      logger.warn(`[SSE] POST for unknown session ${sessionId} from ${clientIp}`);
      res.status(404).json({ error: 'Session not found' });
      return;
    }

    const reqIdentity = getIdentityFromLocals(res) || sessionIdentities.get(sessionId);
    if (resolvedAuthProvider && reqIdentity && sessionIdentities.has(sessionId)) {
      const boundIdentity = sessionIdentities.get(sessionId)!;
      if (boundIdentity.userId !== reqIdentity.userId) {
        logger.warn(`[SSE Auth] Identity mismatch: session bound to ${boundIdentity.userId}, request from ${reqIdentity.userId}`);
        res.status(403).json({ error: 'Forbidden: session belongs to a different user' });
        return;
      }
    }

    logger.debug(`[SSE] Received POST for session ${sessionId} from ${clientIp}`);
    
    try {
      await requestContext.run({ sessionId, identity: reqIdentity }, async () => {
        await transport.handlePostMessage(req, res, req.body);
      });
    } catch (error) {
      logger.error(`[SSE] Error handling POST message:`, error);
      if (!res.headersSent) {
        res.status(500).json({ error: 'Internal server error' });
      }
    }
  });

  // Health check endpoint
  app.get('/health', (_req, res) => {
    res.json({ status: 'ok', transport: 'sse', activeSessions: Object.keys(transports).length });
  });

  app.use((req, res) => {
    logger.warn(`404 Not Found: ${req.method} ${req.originalUrl} from ${req.ip || req.connection.remoteAddress}`);
    res.status(404).json({ ok: false, error: 'Not Found' });
  });

  httpServer.listen(port, () => {
    logger.info(`🌐 SSE MCP server listening on http://localhost:${port}${ssePath}`);
    if (resolvedAuthProvider) {
      logger.info(`🔒 SSE authentication enabled (provider: ${resolvedAuthProvider.name})`);
    } else if (config.MCP_SSE_AUTHORIZATION) {
      logger.info(`🔒 SSE authentication enabled (Bearer token required)`);
    } else {
      logger.warn(`⚠️  SSE authentication disabled (no MCP_SSE_AUTHORIZATION set)`);
    }
  });
}