// src/server/httpServer.ts
import type { ActualMCPConnection } from '../lib/ActualMCPConnection.js';
import express, { Request, Response } from 'express';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import {
  Tool,
  ToolSchema,
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import crypto from 'crypto';
import { logTransport, getLocalIp } from '../utils.js';

export async function startHttpServer(
  mcp: ActualMCPConnection,
  port: number,
  httpPath: string,
  capabilities: Record<string, object>, // already { tools: {} }
  implementedTools: string[],
  serverDescription: string,
  serverInstructions: string,
  toolSchemas: Record<string, any>, // JSON schemas from ActualToolsManager
  bindHost = 'localhost', // host to bind the Express server (e.g. 0.0.0.0)
  advertisedUrl?: string // human-friendly URL to advertise to clients
) {
  const app = express();
  app.use(express.json());

  const serverIp = process.env.MCP_BRIDGE_PUBLIC_HOST || getLocalIp();
  const withServer = (prefix: string, obj: unknown) => logTransport(`${prefix} [server:${serverIp}]`, obj);

  // helper to send SSE framed message and log it
  function sendSSE(res: Response, event: string | null, data: unknown) {
    const payload = event ? `event: ${event}\n` : '';
    // JSON stringify here to ensure consistent log format
    const body = typeof data === 'string' ? data : JSON.stringify(data);
    withServer('SSE OUT', { event, body });
    // SSE framing
    res.write(`${payload}data: ${body}\n\n`);
  }

  const transports = new Map<string, StreamableHTTPServerTransport>();

  function debug(...args: unknown[]) {
    if (process.env.DEBUG === 'true') console.debug('[DEBUG]', ...args);
  }

  function createServerInstance() {
    // Clone capabilities and add tools as objects
    const mcpCapabilities: Record<string, object> = { ...capabilities };
    mcpCapabilities.tools = implementedTools.reduce((acc, toolName) => {
      acc[toolName] = {}; // MCP expects each tool as an object
      return acc;
    }, {} as Record<string, object>);

    // NOTE: Move `instructions` to second argument as required
    const server = new Server(
      {
        name: 'actual-mcp-server',
        version: '1.0.0',
        description: serverDescription, // Remains here
      },
      {
        instructions: serverInstructions,  // <-- MUST be in second arg
        capabilities: mcpCapabilities,    // tools and other capabilities here
      }
    );

    // List available tools
    server.setRequestHandler(ListToolsRequestSchema, async () => {
      debug('Listing available tools');
      const tools: Tool[] = implementedTools.map((toolName) => ({
        name: toolName,
        description: `Tool named ${toolName}`,
        inputSchema: toolSchemas[toolName] || ToolSchema,
      }));
      return { tools };
    });

    // Handle tool calls
    server.setRequestHandler(CallToolRequestSchema, async (request) => {
      const { name, arguments: args } = request.params;
      debug(`Tool call: ${name}`, args);
      try {
        const result = await mcp.executeTool(name, args);
        return result;
      } catch (error) {
        console.error(`Error executing tool ${name}:`, error);
        throw error;
      }
    });

    return { server };
  }

  // POST MCP handler
  app.post(httpPath, async (req: Request, res: Response) => {
    withServer('HTTP REQ', {
      type: 'request',
      method: req.method,
      path: req.path,
      headers: req.headers,
      query: req.query,
      body: req.body,
    });

    try {
      const sessionId = req.headers['mcp-session-id'] as string | undefined;
      const { server } = createServerInstance();

      // If this is an initialization request (no sessionId) create a new transport,
      // connect it and let the transport write the initialization response, then return.
      if (!sessionId) {
        const transport = new StreamableHTTPServerTransport({
          sessionIdGenerator: () => crypto.randomUUID(),
          enableJsonResponse: true,
          onsessioninitialized: (sid: string) => {
            transports.set(sid, transport);
            debug(`Session initialized: ${sid}`);
          },
        });

        // Optional cleanup on server close
        server.onclose = async () => {
          const sid = (transport as any).sessionId;
          if (sid && transports.has(sid)) transports.delete(sid);
        };

        await server.connect(transport);

        // Let the transport handle the request and return immediately.
        await transport.handleRequest(req, res, req.body);
        return;
      }

      // Otherwise, try to reuse an existing transport for this session
      if (!transports.has(sessionId)) {
        // No transport found for provided sessionId -> bad request
        res.status(400).json({ jsonrpc: '2.0', error: { code: -32000, message: 'No valid session ID' }, id: req?.body?.id ?? null });
        return;
      }

      const transport = transports.get(sessionId)!;
      await transport.handleRequest(req, res, req.body);

      // Do not write fallback JSON here — transport is responsible for the response.
    } catch (err: any) {
      withServer('HTTP ERR', {
        type: 'error',
        message: err?.message ?? String(err),
        stack: err?.stack,
      });
      if (!res.headersSent) {
        res.status(err?.status || 500).json({ error: err?.message || String(err) });
      }
    }
  });

  // GET MCP handler (for SSE)
  app.get(httpPath, async (req: Request, res: Response) => {
    withServer('HTTP CONNECT', {
      type: 'sse_connect',
      method: req.method,
      path: req.path,
      headers: req.headers,
      query: req.query,
    });

    try {
      const sessionId = req.headers['mcp-session-id'] as string | undefined;
      if (!sessionId || !transports.has(sessionId)) {
        res.status(400).json({ jsonrpc: '2.0', error: { code: -32000, message: 'No valid session ID' }, id: null });
        return;
      }
      const transport = transports.get(sessionId)!;
      await transport.handleRequest(req, res);

      // If you have a transport instance for this SSE connection, wrap its send/write
      // so outgoing SSE messages are also logged. Example:
      // if (transport && typeof transport.send === 'function') {
      //   const origSend = transport.send.bind(transport);
      //   transport.send = (event, data) => {
      //     withServer('SSE OUT', { event, data });
      //     return origSend(event, data);
      //   };
      // }
    } catch (err: any) {
      withServer('HTTP CONNECT ERR', { message: err?.message || String(err) });
    }
  });

  // DELETE session
  app.delete(httpPath, async (req: Request, res: Response) => {
    const sessionId = req.headers['mcp-session-id'] as string | undefined;
    if (!sessionId || !transports.has(sessionId)) {
      res.status(400).json({ jsonrpc: '2.0', error: { code: -32000, message: 'No valid session ID' }, id: null });
      return;
    }
    const transport = transports.get(sessionId)!;
    await transport.handleRequest(req, res, req.body);
    transports.delete(sessionId);
    debug(`Session ${sessionId} deleted`);
  });

  // Health check
  app.get('/health', (_req, res) => {
    // include server ip in health debug
    withServer('HEALTH', { type: 'health_check', server: serverIp });
    res.status(200).json({ status: 'ok' });
  });

  // Start server, binding to requested host
  app.listen(port, bindHost, () => {
    console.log(`MCP Streamable HTTP Server listening on ${bindHost}:${port}`);
    if (advertisedUrl) {
      console.log(`📨 MCP endpoint: ${advertisedUrl}`);
    } else {
      console.log(`📨 MCP endpoint: http://${bindHost}:${port}${httpPath}`);
    }
    console.log(`❤️ Health check: http://${bindHost}:${port}/health`);
  });

   process.on('SIGINT', async () => {
     console.log('Received SIGINT, shutting down gracefully...');
     // Perform any necessary cleanup here
     transports.forEach(async (transport) => {
       try {
         await transport.close();
       } catch (err) {
         console.error('Error closing transport:', err);
       }
     });
     process.exit(0);
   });
}
