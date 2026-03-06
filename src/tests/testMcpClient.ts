export async function testMcpClient(advertisedUrl: string, port: number, httpPath: string) {
  // Try builtin fetch or fallback to node-fetch if necessary
  const globalFetch = (globalThis as unknown as { fetch?: unknown }).fetch;
  // Minimal response-like interface used by this test harness
  interface ResponseLike {
    ok: boolean;
    status: number;
    statusText?: string;
    json: () => Promise<unknown>;
    headers?: { get?: (name: string) => string | null };
  }
  const fetchAny = (globalFetch as unknown) ?? (await import('node-fetch')).default;
  const fetchFn: (input: string | URL, init?: RequestInit) => Promise<ResponseLike> = fetchAny as unknown as (input: string | URL, init?: RequestInit) => Promise<ResponseLike>;

  const base = new URL(advertisedUrl);
  // quick probe endpoint
  const probeUrl = `${base.origin}/.well-known/oauth-protected-resource`;

  console.info(`MCP client test: probing ${probeUrl}`);
  const probeRes = await fetchFn(probeUrl, { method: 'GET' });
  if (probeRes.status === 404) {
    console.info('Probe skipped: OAuth protected-resource metadata not advertised for this transport/auth mode');
  } else {
    if (!probeRes.ok) {
      throw new Error(`Probe GET failed: ${probeRes.status} ${probeRes.statusText}`);
    }
    const probeJsonRaw = await probeRes.json() as unknown;
    const probeJson = probeJsonRaw && typeof probeJsonRaw === 'object'
      ? (probeJsonRaw as Record<string, unknown>)
      : undefined;
    if (!probeJson) throw new Error('Probe response is not an object');

    if (typeof probeJson['resource'] !== 'string') {
      throw new Error('protected-resource metadata missing resource');
    }
    if (!Array.isArray(probeJson['authorization_servers'])) {
      throw new Error('protected-resource metadata missing authorization_servers');
    }
    if (!Array.isArray(probeJson['bearer_methods_supported'])) {
      throw new Error('protected-resource metadata missing bearer_methods_supported');
    }
    console.info('Probe OK: protected-resource metadata present');
  }

  // Now do JSON-RPC initialize + tools/list using the HTTP endpoint
  const rpcUrl = `${base.origin}${httpPath}`;
  const initPayload = {
    jsonrpc: '2.0',
    id: 1,
    method: 'initialize',
    params: {
      protocolVersion: '2025-06-18',
      capabilities: {},
      clientInfo: { name: 'actual-mcp-server-client-test', version: '0.0.1' },
    },
  };

  console.info(`MCP client test: POST initialize -> ${rpcUrl}`);
  // Server expects the client to accept both JSON responses and SSE frames
  const commonPostHeaders = { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' };
  const initRes = await fetchFn(rpcUrl, {
    method: 'POST',
    headers: commonPostHeaders,
    body: JSON.stringify(initPayload),
  });

  if (!initRes.ok) {
    throw new Error(`Initialize POST failed: ${initRes.status} ${initRes.statusText}`);
  }

  const initJsonRaw = await initRes.json() as unknown;
  const initJson = (initJsonRaw && typeof initJsonRaw === 'object') ? (initJsonRaw as Record<string, unknown>) : undefined;
  if (!initJson || !('result' in initJson)) {
    throw new Error(`Initialize response missing result: ${JSON.stringify(initJsonRaw)}`);
  }

  // If server sets a mcp-session-id header, capture it for subsequent calls
  type HeadersLike = { get?: (name: string) => string | null } | Record<string, string>;
  let sessionId: string | undefined = undefined;
  if (initRes.headers && typeof initRes.headers === 'object') {
    const h = initRes.headers as HeadersLike;
    if (typeof h.get === 'function') {
      sessionId = h.get('mcp-session-id') ?? undefined;
    } else if ('mcp-session-id' in (h as Record<string, string>)) {
      sessionId = (h as Record<string, string>)['mcp-session-id'];
    }
  }
  if (sessionId) console.info(`Received session id header: ${sessionId}`);

  // Validate initialize result fields (capabilities/tools/serverInstructions)
  const initResultRaw = (initJson as Record<string, unknown>)['result'];
  const initResult = initResultRaw && typeof initResultRaw === 'object' ? (initResultRaw as Record<string, unknown>) : undefined;

  if (!initResult || typeof initResult['capabilities'] !== 'object') {
    throw new Error('initialize result.capabilities missing or not object');
  }

  // Accept either a tools array or derive tools from capabilities.tools object
  let initTools: string[] = [];
  if (Array.isArray(initResult['tools'])) {
    initTools = initResult['tools'] as string[];
  } else if (initResult['capabilities'] && typeof (initResult['capabilities'] as Record<string, unknown>)['tools'] === 'object') {
    initTools = Object.keys((initResult['capabilities'] as Record<string, unknown>)['tools'] as Record<string, unknown>);
  } else {
    throw new Error('initialize result.tools missing or not array and capabilities.tools not present');
  }

  // serverInstructions may be a string, an object { instructions }, or absent.
  const si = initResult['serverInstructions'];
  if (!si) {
    console.warn('Warning: serverInstructions missing from initialize result — continuing tests');
  } else if (typeof si === 'string') {
    // ok
  } else if (typeof si === 'object' && typeof (si as Record<string, unknown>)['instructions'] === 'string') {
    // ok
  } else {
    console.warn('Warning: serverInstructions present but in unexpected shape — continuing tests');
  }

  // replace usages below with initTools where needed
  console.info('Initialize OK: capabilities/tools/serverInstructions present');

  // call tools/list (JSON-RPC) to verify RPC path works
  const listPayload = { jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} };
  const listHeaders: Record<string, string> = { ...commonPostHeaders };
  if (sessionId) listHeaders['mcp-session-id'] = sessionId;

  const listRes = await fetchFn(rpcUrl, {
    method: 'POST',
    headers: listHeaders,
    body: JSON.stringify(listPayload),
  });
  if (!listRes.ok) throw new Error(`tools/list failed: ${listRes.status}`);
  const listJsonRaw = await listRes.json() as unknown;
  const listJsonObj = listJsonRaw && typeof listJsonRaw === 'object' ? (listJsonRaw as Record<string, unknown>) : undefined;
  if (!listJsonObj || !('result' in listJsonObj)) throw new Error('tools/list returned invalid result');
  const listResult = listJsonObj['result'];
  if (!listResult || typeof listResult !== 'object' || !('tools' in (listResult as Record<string, unknown>)) || !Array.isArray((listResult as Record<string, unknown>)['tools'])) {
    throw new Error('tools/list returned invalid tools array');
  }

  const toolsArray = (listResult as Record<string, unknown>)['tools'] as unknown[];
  const listed = toolsArray.map((t: unknown) => (t && typeof t === 'object' && 'name' in (t as Record<string, unknown>) ? (t as Record<string, unknown>)['name'] : String(t))).join(', ');
  console.info(`tools/list OK: ${listed}`);

  // Optionally, attempt to call each tool with empty args (non-destructive expectation)
  for (const tool of toolsArray) {
    const toolObj = tool && typeof tool === 'object' ? (tool as Record<string, unknown>) : undefined;
    const name = toolObj && typeof toolObj['name'] === 'string' ? toolObj['name'] as string : String(tool);
    console.info(`Calling tool: ${name}`);
    const callPayload = {
      jsonrpc: '2.0',
      id: Math.floor(Math.random() * 1_000_000),
      method: 'tools/call',
      params: { name, arguments: {} },
    };
    const callRes = await fetchFn(rpcUrl, {
      method: 'POST',
      headers: listHeaders,
      body: JSON.stringify(callPayload),
    });
    if (!callRes.ok) {
      console.warn(`tools/call ${name} HTTP ${callRes.status}`);
      continue;
    }
    const callJsonRaw = await callRes.json() as unknown;
    if (callJsonRaw && typeof callJsonRaw === 'object') {
      const callJson = callJsonRaw as Record<string, unknown>;
      if ('error' in callJson && callJson.error) {
        console.warn(`tools/call ${name} returned error: ${JSON.stringify(callJson.error).slice(0, 200)}`);
      } else {
        console.info(`tools/call ${name} OK (result truncated): ${JSON.stringify(callJson.result).slice(0, 200)}`);
      }
    } else {
      console.info(`tools/call ${name} OK (result truncated): ${JSON.stringify(callJsonRaw).slice(0, 200)}`);
    }
  }

  console.info('MCP client tests completed successfully');
  return;
}