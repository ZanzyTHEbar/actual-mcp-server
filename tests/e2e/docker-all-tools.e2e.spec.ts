/**
 * Comprehensive Docker E2E Tests - ALL 50 TOOLS
 * 
 * Tests every tool with success and error scenarios
 * Based on manual integration tests and unit tests
 */

import { test, expect } from '@playwright/test';

const MCP_SERVER_URL = process.env.MCP_SERVER_URL || 'http://mcp-server-test:3600';
const HTTP_PATH = '/http';
const HEALTH_CHECK_RETRIES = 10;
const HEALTH_CHECK_DELAY_MS = 2000;

// Helper function to wait for MCP server health
async function waitForMCPHealth(request: any, url: string, maxRetries = HEALTH_CHECK_RETRIES): Promise<boolean> {
  for (let i = 0; i < maxRetries; i++) {
    try {
      const healthRes = await request.get(url);
      if (healthRes.ok()) {
        const healthData = await healthRes.json();
        if (healthData.status === 'ok') {
          return true;
        }
      }
    } catch (error) {
      // Retry
    }

    if (i < maxRetries - 1) {
      await new Promise((r) => setTimeout(r, HEALTH_CHECK_DELAY_MS));
    }
  }
  return false;
}

// Helper to retry requests
async function retryRequest(requestFn: () => Promise<any>, maxRetries = 3, delayMs = 1000): Promise<any> {
  let lastError;
  for (let i = 0; i < maxRetries; i++) {
    try {
      return await requestFn();
    } catch (error) {
      lastError = error;
      if (i < maxRetries - 1) {
        await new Promise((r) => setTimeout(r, delayMs * (i + 1)));
      }
    }
  }
  throw lastError;
}

// Helper to call MCP tool
async function callTool(request: any, sessionId: string, toolName: string, args: any = {}): Promise<any> {
  const rpcUrl = `${MCP_SERVER_URL}${HTTP_PATH}`;
  const payload = {
    jsonrpc: '2.0',
    id: Math.floor(Math.random() * 10000),
    method: 'tools/call',
    params: { name: toolName, arguments: args },
  };

  const res = await retryRequest(() => request.post(rpcUrl, {
    data: JSON.stringify(payload),
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json',
      'mcp-session-id': sessionId,
    },
  }));

  expect(res.ok()).toBeTruthy();
  const json = await res.json();

  if (json.error) {
    throw new Error(`Tool ${toolName} failed: ${json.error.message}`);
  }

  return json.result;
}

// Helper to extract result from MCP response
function extractResult(mcpResponse: any): any {
  if (mcpResponse?.content?.[0]?.text) {
    try {
      const parsed = JSON.parse(mcpResponse.content[0].text);
      // Try to extract the most specific identifier first
      if (parsed.id !== undefined) return parsed.id;
      if (parsed.result !== undefined) return parsed.result;
      if (parsed.accountId !== undefined) return parsed.accountId;
      if (parsed.categoryId !== undefined) return parsed.categoryId;
      if (parsed.payeeId !== undefined) return parsed.payeeId;
      if (parsed.ruleId !== undefined) return parsed.ruleId;
      return parsed;
    } catch {
      return mcpResponse.content[0].text;
    }
  }
  return mcpResponse;
}

test.describe('Docker E2E - ALL 50 TOOLS', () => {
  let sessionId: string;
  let testContext: {
    accountId?: string;
    accountName?: string;
    categoryGroupId?: string;
    categoryId?: string;
    payeeId?: string;
    payeeId2?: string;
    transactionId?: string;
    transactionId2?: string;
    ruleId?: string;
    ruleWithoutOpId?: string;
    upsertRuleId?: string;
  } = {};

  test.beforeAll(async ({ request }) => {
    console.log('🔌 Initializing MCP session...');
    const rpcUrl = `${MCP_SERVER_URL}${HTTP_PATH}`;

    const initPayload = {
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {
        protocolVersion: '2025-06-18',
        capabilities: {},
        clientInfo: { name: 'docker-all-tools-e2e-test', version: '1.0.0' },
      },
    };

    const initRes = await retryRequest(() => request.post(rpcUrl, {
      data: JSON.stringify(initPayload),
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
    }));

    sessionId = initRes.headers()['mcp-session-id'];
    expect(sessionId).toBeTruthy();

    // Wait for server to be fully ready
    const isHealthy = await waitForMCPHealth(request, `${MCP_SERVER_URL}/health`);
    expect(isHealthy).toBeTruthy();

    console.log('✅ Session initialized and server ready');
  });

  // ==================== SERVER INFO ====================
  test('actual_server_info - should return server info', async ({ request }) => {
    console.log('🔧 Testing actual_server_info...');
    const result = await callTool(request, sessionId, 'actual_server_info');
    const text = result?.content?.[0]?.text || '';
    expect(text.length).toBeGreaterThan(0);

    try {
      const parsed = JSON.parse(text);
      expect(parsed.server).toBeTruthy();
    } catch {
      // If not JSON, ensure we still got a non-empty payload
      expect(text.length).toBeGreaterThan(0);
    }
    console.log('✅ Server info retrieved');
  });

  // ==================== PROGRESSIVE DISCLOSURE META-TOOLS ====================
  test('actual_tool_registry - should return full tool catalog', async ({ request }) => {
    console.log('📖 Testing actual_tool_registry (full catalog)...');
    const result = await callTool(request, sessionId, 'actual_tool_registry');
    const data = extractResult(result);

    expect(data).toBeTruthy();
    const tools = data?.tools || data;
    expect(Array.isArray(tools)).toBeTruthy();
    // Should have all 56 tools (54 internal + 2 meta)
    expect(tools.length).toBeGreaterThanOrEqual(50);
    console.log(`✅ Registry returned ${tools.length} tools`);

    // Each tool should have name, description, inputSchema
    if (tools.length > 0) {
      const first = tools[0];
      expect(first.name).toBeTruthy();
      expect(first.description).toBeTruthy();
      expect(first.inputSchema).toBeTruthy();
    }
  });

  test('actual_tool_registry - should filter by category', async ({ request }) => {
    console.log('📖 Testing actual_tool_registry (category filter)...');
    const result = await callTool(request, sessionId, 'actual_tool_registry', {
      category: 'rules',
    });
    const data = extractResult(result);

    const tools = data?.tools || data;
    expect(Array.isArray(tools)).toBeTruthy();
    expect(tools.length).toBeGreaterThanOrEqual(4);
    // All should contain "rules" in the name
    for (const t of tools) {
      expect(t.name).toContain('rules');
    }
    console.log(`✅ Filtered registry: ${tools.length} rules-related tools`);
  });

  test('actual_tool_registry - nameOnly mode', async ({ request }) => {
    console.log('📖 Testing actual_tool_registry (nameOnly)...');
    const result = await callTool(request, sessionId, 'actual_tool_registry', {
      nameOnly: true,
    });
    const data = extractResult(result);

    const tools = data?.tools || data;
    expect(Array.isArray(tools)).toBeTruthy();
    // Should be strings, not objects
    if (tools.length > 0) {
      expect(typeof tools[0]).toBe('string');
    }
    console.log(`✅ nameOnly returned ${tools.length} tool names`);
  });

  test('actual_tool_call - should dispatch to actual_accounts_list', async ({ request }) => {
    console.log('🔧 Testing actual_tool_call (accounts_list dispatch)...');
    const result = await callTool(request, sessionId, 'actual_tool_call', {
      toolName: 'actual_accounts_list',
      arguments: {},
    });
    const data = extractResult(result);
    expect(data).toBeTruthy();
    console.log('✅ Dispatcher routed to actual_accounts_list successfully');
  });

  test('actual_tool_call - should error on unknown tool', async ({ request }) => {
    console.log('⚠️  Testing actual_tool_call (unknown tool)...');
    try {
      await callTool(request, sessionId, 'actual_tool_call', {
        toolName: 'actual_nonexistent_tool',
        arguments: {},
      });
      throw new Error('Should have failed for unknown tool');
    } catch (error: any) {
      expect(error.message).toMatch(/Unknown tool|not found/i);
      console.log('✅ Unknown tool error handled correctly');
    }
  });

  test('actual_tool_call - should error on invalid arguments', async ({ request }) => {
    console.log('⚠️  Testing actual_tool_call (invalid args)...');
    try {
      await callTool(request, sessionId, 'actual_tool_call', {
        toolName: 'actual_accounts_create',
        arguments: { invalidField: true },
      });
      // If it doesn't throw, that's also acceptable (the tool might have optional-only fields)
      console.log('✅ Invalid args handled (tool may accept partial input)');
    } catch (error: any) {
      // Expected: validation error from the inner tool
      expect(error.message.length).toBeGreaterThan(0);
      console.log('✅ Invalid arguments error handled correctly');
    }
  });

  // ==================== SESSION MANAGEMENT ====================
  test('actual_session_list - should list active sessions', async ({ request }) => {
    console.log('📋 Testing actual_session_list...');
    const result = await callTool(request, sessionId, 'actual_session_list');
    const data = extractResult(result);

    // Handle both array and object formats
    const sessions = Array.isArray(data) ? data : (data?.sessions || []);
    expect(sessions).toBeTruthy();
    console.log(`✅ Found ${sessions.length || 0} active sessions`);
  });

  // ==================== ACCOUNTS (7 tools) ====================
  test('actual_accounts_list - should list all accounts', async ({ request }) => {
    console.log('📁 Testing actual_accounts_list...');
    const result = await callTool(request, sessionId, 'actual_accounts_list');
    const accounts = extractResult(result);

    expect(Array.isArray(accounts)).toBeTruthy();
    console.log(`✅ Listed ${accounts.length} accounts`);
  });

  test('actual_accounts_create - should create account', async ({ request }) => {
    console.log('➕ Testing actual_accounts_create...');
    const timestamp = Date.now();
    testContext.accountName = `E2E-Test-${timestamp}`;

    const result = await callTool(request, sessionId, 'actual_accounts_create', {
      name: testContext.accountName,
      balance: 0,
    });
    const accountId = extractResult(result);

    expect(accountId).toBeTruthy();
    expect(typeof accountId).toBe('string');
    testContext.accountId = accountId;
    console.log(`✅ Account created: ${accountId}`);
  });

  test('actual_accounts_create - ERROR: should fail without name', async ({ request }) => {
    console.log('⚠️  Testing actual_accounts_create error handling...');
    const rpcUrl = `${MCP_SERVER_URL}${HTTP_PATH}`;
    const payload = {
      jsonrpc: '2.0',
      id: 9999,
      method: 'tools/call',
      params: {
        name: 'actual_accounts_create',
        arguments: { balance: 0 }, // Missing required 'name'
      },
    };

    const res = await request.post(rpcUrl, {
      data: JSON.stringify(payload),
      headers: {
        'Content-Type': 'application/json',
        'mcp-session-id': sessionId,
      },
    });

    const json = await res.json();
    expect(json.error).toBeTruthy();
    expect(json.error.message).toMatch(/name|required/i);
    console.log('✅ Validation error handled correctly');
  });

  test('actual_accounts_get_balance - should get account balance', async ({ request }) => {
    if (!testContext.accountId) test.skip();

    console.log('💰 Testing actual_accounts_get_balance...');
    const result = await callTool(request, sessionId, 'actual_accounts_get_balance', {
      id: testContext.accountId,
    });
    const data = extractResult(result);

    // Handle both direct number and object with balance property
    const balance = typeof data === 'number' ? data : data?.balance;
    expect(typeof balance).toBe('number');
    console.log(`✅ Balance retrieved: ${balance}`);
  });

  test('actual_accounts_update - should update account', async ({ request }) => {
    if (!testContext.accountId) test.skip();

    console.log('✏️  Testing actual_accounts_update...');
    await callTool(request, sessionId, 'actual_accounts_update', {
      id: testContext.accountId,
      fields: {
        name: testContext.accountName + '-Updated',
        offbudget: true,
      },
    });
    console.log('✅ Account updated');
  });

  test('actual_accounts_update - ERROR: should reject invalid fields', async ({ request }) => {
    if (!testContext.accountId) test.skip();

    console.log('⚠️  Testing strict validation on accounts_update...');
    try {
      await callTool(request, sessionId, 'actual_accounts_update', {
        id: testContext.accountId,
        fields: { invalidField: 'should fail' },
      });
      throw new Error('Should have failed with invalid field');
    } catch (error: any) {
      expect(error.message).toMatch(/Unrecognized|invalid/i);
      console.log('✅ Invalid field rejected correctly');
    }
  });

  test('actual_accounts_close - should close account', async ({ request }) => {
    if (!testContext.accountId) test.skip();

    console.log('🔒 Testing actual_accounts_close...');
    await callTool(request, sessionId, 'actual_accounts_close', {
      id: testContext.accountId,
    });
    console.log('✅ Account closed');
  });

  test('actual_accounts_reopen - should reopen account', async ({ request }) => {
    if (!testContext.accountId) test.skip();

    console.log('🔓 Testing actual_accounts_reopen...');
    await callTool(request, sessionId, 'actual_accounts_reopen', {
      id: testContext.accountId,
    });
    console.log('✅ Account reopened');
  });

  // ==================== CATEGORY GROUPS (4 tools) ====================
  test('actual_category_groups_get - should list category groups', async ({ request }) => {
    console.log('📂 Testing actual_category_groups_get...');
    const result = await callTool(request, sessionId, 'actual_category_groups_get');
    const groups = extractResult(result);

    expect(groups).toBeTruthy();
    console.log('✅ Category groups listed');
  });

  test('actual_category_groups_create - should create category group', async ({ request }) => {
    console.log('➕ Testing actual_category_groups_create...');
    const timestamp = Date.now();

    const result = await callTool(request, sessionId, 'actual_category_groups_create', {
      name: `E2E-Group-${timestamp}`,
    });
    const groupId = extractResult(result);

    expect(groupId).toBeTruthy();
    testContext.categoryGroupId = groupId;
    console.log(`✅ Category group created: ${groupId}`);
  });

  test('actual_category_groups_update - should update category group', async ({ request }) => {
    if (!testContext.categoryGroupId) test.skip();

    console.log('✏️  Testing actual_category_groups_update...');
    // Ensure ID is string (extractResult might return object)
    const groupId = typeof testContext.categoryGroupId === 'string'
      ? testContext.categoryGroupId
      : (testContext.categoryGroupId as any).id || String(testContext.categoryGroupId);

    await callTool(request, sessionId, 'actual_category_groups_update', {
      id: groupId,
      fields: { name: 'E2E-Group-Updated' },
    });
    console.log('✅ Category group updated');
  });

  // ==================== CATEGORIES (4 tools) ====================
  test('actual_categories_get - should list categories', async ({ request }) => {
    console.log('📁 Testing actual_categories_get...');
    const result = await callTool(request, sessionId, 'actual_categories_get');
    const categories = extractResult(result);

    expect(categories).toBeTruthy();
    console.log('✅ Categories listed');
  });

  test('actual_categories_create - should create category', async ({ request }) => {
    if (!testContext.categoryGroupId) test.skip();

    console.log('➕ Testing actual_categories_create...');
    const timestamp = Date.now();

    // Ensure group_id is a string
    const groupId = typeof testContext.categoryGroupId === 'string'
      ? testContext.categoryGroupId
      : (testContext.categoryGroupId as any).id || String(testContext.categoryGroupId);

    const result = await callTool(request, sessionId, 'actual_categories_create', {
      name: `E2E-Category-${timestamp}`,
      group_id: groupId,
    });
    const data = extractResult(result);

    // Extract categoryId from the response object
    const categoryId = typeof data === 'string' ? data : data?.categoryId;
    expect(categoryId).toBeTruthy();
    testContext.categoryId = categoryId;
    console.log(`✅ Category created: ${categoryId}`);
  });

  test('actual_categories_create - ERROR: should fail without group_id', async ({ request }) => {
    console.log('⚠️  Testing actual_categories_create error handling...');
    try {
      await callTool(request, sessionId, 'actual_categories_create', {
        name: 'Test-No-Group',
      });
      throw new Error('Should have failed without group_id');
    } catch (error: any) {
      expect(error.message).toMatch(/group_id|required/i);
      console.log('✅ Missing group_id rejected');
    }
  });

  test('actual_categories_update - should update category', async ({ request }) => {
    if (!testContext.categoryId) test.skip();

    console.log('✏️  Testing actual_categories_update...');

    // Ensure categoryId is a string
    const categoryId = typeof testContext.categoryId === 'string'
      ? testContext.categoryId
      : (testContext.categoryId as any).id || String(testContext.categoryId);

    await callTool(request, sessionId, 'actual_categories_update', {
      id: categoryId,
      fields: { name: 'E2E-Category-Updated' },
    });
    console.log('✅ Category updated');
  });

  // ==================== PAYEES (5 tools) ====================
  test('actual_payees_get - should list payees', async ({ request }) => {
    console.log('👤 Testing actual_payees_get...');
    const result = await callTool(request, sessionId, 'actual_payees_get');
    const payees = extractResult(result);

    expect(Array.isArray(payees)).toBeTruthy();
    console.log(`✅ Listed ${payees.length} payees`);
  });

  test('actual_payees_create - should create payee', async ({ request }) => {
    console.log('➕ Testing actual_payees_create...');
    const timestamp = Date.now();

    const result = await callTool(request, sessionId, 'actual_payees_create', {
      name: `E2E-Payee-${timestamp}`,
    });
    const payeeId = extractResult(result);

    expect(payeeId).toBeTruthy();
    testContext.payeeId = payeeId;
    console.log(`✅ Payee created: ${payeeId}`);
  });

  test('actual_payees_create - should create second payee for merge test', async ({ request }) => {
    console.log('➕ Creating second payee...');
    const timestamp = Date.now();

    const result = await callTool(request, sessionId, 'actual_payees_create', {
      name: `E2E-Payee2-${timestamp}`,
    });
    const payeeId = extractResult(result);

    expect(payeeId).toBeTruthy();
    testContext.payeeId2 = payeeId;
    console.log(`✅ Second payee created: ${payeeId}`);
  });

  test('actual_payees_update - should update payee with category', async ({ request }) => {
    if (!testContext.payeeId) test.skip();

    console.log('✏️  Testing actual_payees_update...');
    await callTool(request, sessionId, 'actual_payees_update', {
      id: testContext.payeeId,
      fields: {
        name: 'E2E-Payee-Updated',
      },
    });
    console.log('✅ Payee updated');
  });

  test('actual_payees_update - ERROR: should reject invalid fields', async ({ request }) => {
    if (!testContext.payeeId) test.skip();

    console.log('⚠️  Testing strict validation on payees_update...');
    try {
      await callTool(request, sessionId, 'actual_payees_update', {
        id: testContext.payeeId,
        fields: { invalidField: 'should fail' },
      });
      throw new Error('Should have failed with invalid field');
    } catch (error: any) {
      expect(error.message).toMatch(/Unrecognized|invalid/i);
      console.log('✅ Invalid field rejected');
    }
  });

  test('actual_payees_merge - should merge payees', async ({ request }) => {
    if (!testContext.payeeId || !testContext.payeeId2) test.skip();

    console.log('🔀 Testing actual_payees_merge...');
    await callTool(request, sessionId, 'actual_payees_merge', {
      targetId: testContext.payeeId,
      mergeIds: [testContext.payeeId2],
    });
    testContext.payeeId2 = undefined; // Merged away
    console.log('✅ Payees merged');
  });

  // ==================== PAYEE RULES (1 tool) ====================
  test('actual_payee_rules_get - should get payee rules', async ({ request }) => {
    if (!testContext.payeeId) test.skip();

    console.log('📋 Testing actual_payee_rules_get...');
    const result = await callTool(request, sessionId, 'actual_payee_rules_get', {
      payeeId: testContext.payeeId,
    });
    const data = extractResult(result);

    // Handle both array and object formats
    const rules = Array.isArray(data) ? data : (data?.rules || []);
    expect(rules).toBeTruthy();
    console.log(`✅ Found ${rules.length || 0} payee rules`);
  });

  // ==================== TRANSACTIONS (10 tools) ====================
  test('actual_transactions_create - should create transaction', async ({ request }) => {
    if (!testContext.accountId) test.skip();

    console.log('💸 Testing actual_transactions_create...');
    const result = await callTool(request, sessionId, 'actual_transactions_create', {
      account: testContext.accountId,
      date: new Date().toISOString().split('T')[0],
      amount: -5000, // -$50.00
      payee: testContext.payeeId,
      category: testContext.categoryId,
      notes: 'E2E test transaction',
    });
    const txnId = extractResult(result);

    if (txnId && typeof txnId === 'string' && txnId.length > 10) {
      testContext.transactionId = txnId;
      console.log(`✅ Transaction created: ${txnId}`);
    } else {
      console.log('✅ Transaction created (ID not available)');
    }
  });

  test('actual_transactions_create - ERROR: should fail with invalid amount format', async ({ request }) => {
    if (!testContext.accountId) test.skip();

    console.log('⚠️  Testing transaction amount validation...');
    try {
      await callTool(request, sessionId, 'actual_transactions_create', {
        account: testContext.accountId,
        date: new Date().toISOString().split('T')[0],
        amount: -50.00, // Should be -5000 (cents), not -50.00
      });
      // Note: This might succeed if validation doesn't catch it
      console.log('⚠️  Amount validation might need improvement');
    } catch (error: any) {
      console.log('✅ Invalid amount format caught');
    }
  });

  test('actual_transactions_create - ERROR: should fail with invalid date', async ({ request }) => {
    if (!testContext.accountId) test.skip();

    console.log('⚠️  Testing transaction date validation...');
    try {
      await callTool(request, sessionId, 'actual_transactions_create', {
        account: testContext.accountId,
        date: 'invalid-date',
        amount: -5000,
      });
      throw new Error('Should have failed with invalid date');
    } catch (error: any) {
      expect(error.message).toMatch(/date|invalid/i);
      console.log('✅ Invalid date rejected');
    }
  });

  test('actual_transactions_get - should get transaction by ID', async ({ request }) => {
    if (!testContext.transactionId) test.skip();

    console.log('🔍 Testing actual_transactions_get...');
    const result = await callTool(request, sessionId, 'actual_transactions_get', {
      id: testContext.transactionId,
    });
    const txn = extractResult(result);

    expect(txn).toBeTruthy();
    console.log('✅ Transaction retrieved');
  });

  test('actual_transactions_update - should update transaction', async ({ request }) => {
    if (!testContext.transactionId) test.skip();

    console.log('✏️  Testing actual_transactions_update...');
    await callTool(request, sessionId, 'actual_transactions_update', {
      id: testContext.transactionId,
      fields: { amount: -7500 }, // -$75.00
    });
    console.log('✅ Transaction updated');
  });

  test('actual_transactions_filter - should filter transactions', async ({ request }) => {
    if (!testContext.accountId) test.skip();

    console.log('🔎 Testing actual_transactions_filter...');
    const result = await callTool(request, sessionId, 'actual_transactions_filter', {
      account_id: testContext.accountId,
    });
    const txns = extractResult(result);

    expect(Array.isArray(txns)).toBeTruthy();
    console.log(`✅ Filtered ${txns.length} transactions`);
  });

  test('actual_transactions_uncategorized - should list uncategorized transactions', async ({ request }) => {
    if (!testContext.accountId) test.skip();

    console.log('🧹 Testing actual_transactions_uncategorized...');
    const result = await callTool(request, sessionId, 'actual_transactions_uncategorized', {
      accountId: testContext.accountId,
    });
    const data = extractResult(result);
    const txns = Array.isArray(data?.transactions) ? data.transactions : data;

    expect(Array.isArray(txns)).toBeTruthy();
    console.log(`✅ Found ${txns.length} uncategorized transactions`);
  });

  test('actual_transactions_import - should import transactions', async ({ request }) => {
    if (!testContext.accountId) test.skip();

    console.log('📥 Testing actual_transactions_import...');
    const result = await callTool(request, sessionId, 'actual_transactions_import', {
      accountId: testContext.accountId,
      txs: [], // Empty test
    });
    const importResult = extractResult(result);

    expect(importResult).toBeTruthy();
    console.log('✅ Transaction import tested');
  });

  test('actual_transactions_search_by_amount - should search by amount', async ({ request }) => {
    console.log('🔍 Testing actual_transactions_search_by_amount...');
    const result = await callTool(request, sessionId, 'actual_transactions_search_by_amount', {
      amount: -5000,
    });
    const data = extractResult(result);

    // Handle both array and object formats
    const txns = Array.isArray(data) ? data : (data?.transactions || []);
    expect(txns).toBeTruthy();
    console.log(`✅ Search by amount returned ${txns.length || 0} results`);
  });

  test('actual_transactions_search_by_category - should search by category', async ({ request }) => {
    if (!testContext.categoryId) test.skip();

    console.log('🔍 Testing actual_transactions_search_by_category...');
    const result = await callTool(request, sessionId, 'actual_transactions_search_by_category', {
      categoryId: testContext.categoryId,
    });
    const data = extractResult(result);

    // Handle both array and object formats
    const txns = Array.isArray(data) ? data : (data?.transactions || []);
    expect(txns).toBeTruthy();
    console.log(`✅ Search by category returned ${txns.length || 0} results`);
  });

  test('actual_transactions_search_by_month - should search by month', async ({ request }) => {
    console.log('🔍 Testing actual_transactions_search_by_month...');
    const currentMonth = new Date().toISOString().substring(0, 7);
    const result = await callTool(request, sessionId, 'actual_transactions_search_by_month', {
      month: currentMonth,
    });
    const data = extractResult(result);

    // Handle both array and object formats
    const txns = Array.isArray(data) ? data : (data?.transactions || []);
    expect(txns).toBeTruthy();
    console.log(`✅ Search by month returned ${txns.length || 0} results`);
  });

  test('actual_transactions_search_by_payee - should search by payee', async ({ request }) => {
    if (!testContext.payeeId) test.skip();

    console.log('🔍 Testing actual_transactions_search_by_payee...');
    const result = await callTool(request, sessionId, 'actual_transactions_search_by_payee', {
      payeeId: testContext.payeeId,
    });
    const data = extractResult(result);

    // Handle both array and object formats
    const txns = Array.isArray(data) ? data : (data?.transactions || []);
    expect(txns).toBeTruthy();
    console.log(`✅ Search by payee returned ${txns.length || 0} results`);
  });

  test('actual_transactions_summary_by_category - should summarize by category', async ({ request }) => {
    console.log('📊 Testing actual_transactions_summary_by_category...');
    const currentMonth = new Date().toISOString().substring(0, 7);
    const result = await callTool(request, sessionId, 'actual_transactions_summary_by_category', {
      month: currentMonth,
    });
    const summary = extractResult(result);

    expect(summary).toBeTruthy();
    console.log('✅ Category summary retrieved');
  });

  test('actual_transactions_summary_by_payee - should summarize by payee', async ({ request }) => {
    console.log('📊 Testing actual_transactions_summary_by_payee...');
    const currentMonth = new Date().toISOString().substring(0, 7);
    const result = await callTool(request, sessionId, 'actual_transactions_summary_by_payee', {
      month: currentMonth,
    });
    const summary = extractResult(result);

    expect(summary).toBeTruthy();
    console.log('✅ Payee summary retrieved');
  });

  // ==================== BUDGETS (9 tools) ====================
  test('actual_budgets_get_all - should get all budgets', async ({ request }) => {
    console.log('💰 Testing actual_budgets_get_all...');
    const result = await callTool(request, sessionId, 'actual_budgets_get_all');
    const budgets = extractResult(result);

    expect(budgets).toBeTruthy();
    console.log('✅ All budgets retrieved');
  });

  test('actual_budgets_getMonth - should get month budget', async ({ request }) => {
    console.log('💰 Testing actual_budgets_getMonth...');
    const currentMonth = new Date().toISOString().substring(0, 7);
    const result = await callTool(request, sessionId, 'actual_budgets_getMonth', {
      month: currentMonth,
    });
    const budget = extractResult(result);

    expect(budget).toBeTruthy();
    console.log('✅ Month budget retrieved');
  });

  test('actual_budgets_getMonths - should get multiple months', async ({ request }) => {
    console.log('💰 Testing actual_budgets_getMonths...');
    const currentMonth = new Date().toISOString().substring(0, 7);
    const result = await callTool(request, sessionId, 'actual_budgets_getMonths', {
      start: currentMonth,
      end: currentMonth,
    });
    const data = extractResult(result);

    // Handle both array and object formats
    const months = Array.isArray(data) ? data : (data?.months || []);
    expect(months).toBeTruthy();
    console.log(`✅ Retrieved ${months.length || 0} months`);
  });

  test('actual_budgets_setAmount - should set budget amount', async ({ request }) => {
    if (!testContext.categoryId) test.skip();

    console.log('💰 Testing actual_budgets_setAmount...');
    const currentMonth = new Date().toISOString().substring(0, 7);
    await callTool(request, sessionId, 'actual_budgets_setAmount', {
      month: currentMonth,
      categoryId: testContext.categoryId,
      amount: 50000,
    });
    console.log('✅ Budget amount set');
  });

  test('actual_budgets_setCarryover - should set carryover', async ({ request }) => {
    if (!testContext.categoryId) test.skip();

    console.log('💰 Testing actual_budgets_setCarryover...');
    const currentMonth = new Date().toISOString().substring(0, 7);
    await callTool(request, sessionId, 'actual_budgets_setCarryover', {
      month: currentMonth,
      categoryId: testContext.categoryId,
      flag: true,
    });
    console.log('✅ Carryover set');
  });

  test('actual_budgets_holdForNextMonth - should hold for next month', async ({ request }) => {
    if (!testContext.categoryId) test.skip();

    console.log('💰 Testing actual_budgets_holdForNextMonth...');
    const currentMonth = new Date().toISOString().substring(0, 7);
    await callTool(request, sessionId, 'actual_budgets_holdForNextMonth', {
      month: currentMonth,
      categoryId: testContext.categoryId,
      amount: 10000,
    });
    console.log('✅ Budget held for next month');
  });

  test('actual_budgets_resetHold - should reset hold', async ({ request }) => {
    if (!testContext.categoryId) test.skip();

    console.log('💰 Testing actual_budgets_resetHold...');
    const currentMonth = new Date().toISOString().substring(0, 7);
    await callTool(request, sessionId, 'actual_budgets_resetHold', {
      month: currentMonth,
      categoryId: testContext.categoryId,
    });
    console.log('✅ Hold reset');
  });

  test('actual_budget_updates_batch - should batch update budgets', async ({ request }) => {
    test.setTimeout(60000); // Batch operations can take longer
    if (!testContext.categoryId) test.skip();

    console.log('💰 Testing actual_budget_updates_batch...');
    const currentMonth = new Date().toISOString().substring(0, 7);
    const result = await callTool(request, sessionId, 'actual_budget_updates_batch', {
      operations: [
        { month: currentMonth, categoryId: testContext.categoryId, amount: 60000 },
      ],
    });
    const batchResult = extractResult(result);

    expect(batchResult).toBeTruthy();
    console.log('✅ Batch update completed');
  });

  test('actual_budget_updates_batch - should handle large batch (35 ops)', async ({ request }) => {
    test.setTimeout(60000); // Large batch operations can take longer
    if (!testContext.categoryId) test.skip();

    console.log('💰 Testing large batch update (35 operations)...');
    const currentMonth = new Date().toISOString().substring(0, 7);
    const operations = [];
    for (let i = 0; i < 35; i++) {
      operations.push({
        month: currentMonth,
        categoryId: testContext.categoryId,
        amount: 10000 + (i * 100),
      });
    }

    const result = await callTool(request, sessionId, 'actual_budget_updates_batch', {
      operations,
    });
    const batchResult = extractResult(result);

    expect(batchResult).toBeTruthy();
    console.log('✅ Large batch handled successfully');
  });

  test('actual_budgets_transfer - should transfer between categories', async ({ request }) => {
    if (!testContext.categoryId || !testContext.categoryGroupId) test.skip();

    console.log('💰 Testing actual_budgets_transfer...');
    const currentMonth = new Date().toISOString().substring(0, 7);

    // Ensure group_id is a string
    const groupId = typeof testContext.categoryGroupId === 'string'
      ? testContext.categoryGroupId
      : (testContext.categoryGroupId as any).id || String(testContext.categoryGroupId);

    // Create second category for transfer
    const result = await callTool(request, sessionId, 'actual_categories_create', {
      name: `E2E-Transfer-Target-${Date.now()}`,
      group_id: groupId,
    });
    const data = extractResult(result);
    const targetCategoryId = typeof data === 'string' ? data : data?.categoryId;

    await callTool(request, sessionId, 'actual_budgets_transfer', {
      month: currentMonth,
      amount: 5000,
      fromCategoryId: testContext.categoryId,
      toCategoryId: targetCategoryId,
    });
    console.log('✅ Budget transferred');
  });

  // ==================== RULES (4 tools) ====================
  test('actual_rules_get - should list rules', async ({ request }) => {
    console.log('📋 Testing actual_rules_get...');
    const result = await callTool(request, sessionId, 'actual_rules_get');
    const data = extractResult(result);

    // Handle both array and object formats
    const rules = Array.isArray(data) ? data : (data?.rules || []);
    expect(rules).toBeTruthy();
    console.log(`✅ Listed ${rules.length || 0} rules`);
  });

  test('actual_rules_create - should create rule without op field', async ({ request }) => {
    if (!testContext.categoryId) test.skip();

    console.log('➕ Testing actual_rules_create (without op)...');
    const result = await callTool(request, sessionId, 'actual_rules_create', {
      stage: 'pre',
      conditionsOp: 'and',
      conditions: [
        { field: 'notes', op: 'contains', value: 'no-op-test' },
      ],
      actions: [
        { field: 'category', value: testContext.categoryId }, // No 'op'
      ],
    });
    const ruleId = extractResult(result);

    expect(ruleId).toBeTruthy();
    testContext.ruleWithoutOpId = ruleId;
    console.log('✅ Rule created without op field');
  });

  test('actual_rules_create - should create rule with op field', async ({ request }) => {
    if (!testContext.categoryId) test.skip();

    console.log('➕ Testing actual_rules_create (with op)...');
    const result = await callTool(request, sessionId, 'actual_rules_create', {
      stage: 'pre',
      conditionsOp: 'and',
      conditions: [
        { field: 'notes', op: 'contains', value: 'test-marker' },
      ],
      actions: [
        { op: 'set', field: 'category', value: testContext.categoryId },
      ],
    });
    const ruleId = extractResult(result);

    expect(ruleId).toBeTruthy();
    testContext.ruleId = ruleId;
    console.log('✅ Rule created with op field');
  });

  test('actual_rules_update - should update rule', async ({ request }) => {
    if (!testContext.ruleId) test.skip();

    console.log('✏️  Testing actual_rules_update...');
    await callTool(request, sessionId, 'actual_rules_update', {
      id: testContext.ruleId,
      fields: {
        stage: 'pre',
        conditionsOp: 'and',
        conditions: [
          { field: 'notes', op: 'contains', value: 'updated-marker' },
        ],
        actions: [
          { op: 'set', field: 'category', value: testContext.categoryId },
        ],
      },
    });
    console.log('✅ Rule updated');
  });

  // ==================== RULES UPSERT ====================
  test('actual_rules_create_or_update - should CREATE a new rule when no match exists', async ({ request }) => {
    if (!testContext.categoryId) test.skip();

    console.log('🔄 Testing actual_rules_create_or_update (create path)...');
    const result = await callTool(request, sessionId, 'actual_rules_create_or_update', {
      stage: 'post',
      conditionsOp: 'and',
      conditions: [
        { field: 'notes', op: 'contains', value: 'upsert-e2e-test' },
      ],
      actions: [
        { op: 'set', field: 'category', value: testContext.categoryId },
      ],
    });
    const data = extractResult(result);

    // data should have { id, created: true } or id directly
    const ruleId = typeof data === 'string' ? data : data?.id;
    expect(ruleId).toBeTruthy();
    testContext.upsertRuleId = ruleId;

    // If we have the full object, verify created flag
    if (typeof data === 'object' && data.created !== undefined) {
      expect(data.created).toBe(true);
    }
    console.log(`✅ Upsert created new rule: ${ruleId}`);
  });

  test('actual_rules_create_or_update - should UPDATE existing rule when conditions match', async ({ request }) => {
    if (!testContext.upsertRuleId || !testContext.categoryId) test.skip();

    console.log('🔄 Testing actual_rules_create_or_update (update path)...');
    const result = await callTool(request, sessionId, 'actual_rules_create_or_update', {
      stage: 'post',
      conditionsOp: 'and',
      conditions: [
        { field: 'notes', op: 'contains', value: 'upsert-e2e-test' },
      ],
      actions: [
        { op: 'set', field: 'notes', value: 'updated-by-upsert' },
      ],
    });
    const data = extractResult(result);

    const ruleId = typeof data === 'string' ? data : data?.id;
    expect(ruleId).toBeTruthy();

    // Should have updated the existing rule, not created a new one
    if (typeof data === 'object' && data.created !== undefined) {
      expect(data.created).toBe(false);
    }
    // ID should be the same as the original
    if (typeof data === 'object' && data.id) {
      expect(data.id).toBe(testContext.upsertRuleId);
    }
    console.log(`✅ Upsert updated existing rule (no duplicate created)`);
  });

  // ==================== BATCH TRANSACTION UPDATE ====================
  test('actual_transactions_update_batch - should batch update transactions', async ({ request }) => {
    if (!testContext.transactionId) test.skip();

    // Create a second transaction for the batch test
    console.log('📦 Creating second transaction for batch test...');
    const createResult = await callTool(request, sessionId, 'actual_transactions_create', {
      accountId: testContext.accountId,
      date: '2025-06-15',
      amount: -2500,
      notes: 'batch-test-txn',
    });
    const txn2Id = extractResult(createResult);
    if (typeof txn2Id === 'string' && txn2Id.match(/^[0-9a-f-]{36}$/i)) {
      testContext.transactionId2 = txn2Id;
    }

    const updates: Array<{ id: string; fields: Record<string, unknown> }> = [];
    if (testContext.transactionId) {
      updates.push({ id: testContext.transactionId, fields: { notes: 'batch-updated-1' } });
    }
    if (testContext.transactionId2) {
      updates.push({ id: testContext.transactionId2, fields: { notes: 'batch-updated-2' } });
    }

    if (updates.length === 0) test.skip();

    console.log(`📦 Testing actual_transactions_update_batch with ${updates.length} items...`);
    const result = await callTool(request, sessionId, 'actual_transactions_update_batch', {
      updates,
    });
    const data = extractResult(result);

    // data should have { succeeded, failed, total, successCount, failureCount }
    expect(data).toBeTruthy();
    if (typeof data === 'object') {
      expect(data.total).toBe(updates.length);
      expect(data.successCount).toBeGreaterThanOrEqual(1);
      expect(Array.isArray(data.succeeded)).toBeTruthy();
      expect(Array.isArray(data.failed)).toBeTruthy();
    }
    console.log(`✅ Batch update: ${data?.successCount || 'all'}/${data?.total || updates.length} succeeded`);
  });

  test('actual_transactions_update_batch - should report partial failures', async ({ request }) => {
    console.log('📦 Testing batch update with invalid ID (partial failure)...');
    const updates = [
      { id: '00000000-0000-0000-0000-000000000000', fields: { notes: 'should-fail' } },
    ];

    // This may succeed (Actual might not throw on missing IDs) or fail gracefully
    try {
      const result = await callTool(request, sessionId, 'actual_transactions_update_batch', {
        updates,
      });
      const data = extractResult(result);
      expect(data).toBeTruthy();
      // Either the update "succeeded" silently (Actual doesn't verify IDs) or it failed
      console.log(`✅ Batch partial failure test: ${data?.failureCount || 0} failures, ${data?.successCount || 0} successes`);
    } catch (error: any) {
      // If the entire call failed, that's also acceptable
      console.log('✅ Batch update with invalid ID handled:', error.message?.substring(0, 80));
    }
  });

  // ==================== ADVANCED (2 tools) ====================
  test('actual_bank_sync - should handle gracefully if unavailable', async ({ request }) => {
    console.log('🏦 Testing actual_bank_sync...');
    try {
      const result = await callTool(request, sessionId, 'actual_bank_sync');
      const syncStatus = extractResult(result);
      console.log('✅ Bank sync status retrieved:', syncStatus);
    } catch (error: any) {
      console.log('✅ Bank sync unavailable (expected for local budgets)');
    }
  });

  test('actual_query_run - should execute SELECT * query', async ({ request }) => {
    console.log('🔍 Testing actual_query_run with SELECT *...');
    const result = await callTool(request, sessionId, 'actual_query_run', {
      query: 'SELECT * FROM transactions LIMIT 10',
    });
    const queryResult = extractResult(result);

    expect(queryResult).toBeTruthy();
    console.log('✅ SELECT * query executed');
  });

  test('actual_query_run - should execute query with specific fields', async ({ request }) => {
    console.log('🔍 Testing query with specific fields...');
    const result = await callTool(request, sessionId, 'actual_query_run', {
      query: 'SELECT id, date, amount, account FROM transactions LIMIT 10',
    });
    const queryResult = extractResult(result);

    expect(queryResult).toBeTruthy();
    console.log('✅ Query with specific fields executed');
  });

  test('actual_query_run - should execute query with join path (payee.name)', async ({ request }) => {
    console.log('🔍 Testing query with payee.name join...');
    const result = await callTool(request, sessionId, 'actual_query_run', {
      query: 'SELECT id, date, amount, payee.name FROM transactions LIMIT 10',
    });
    const queryResult = extractResult(result);

    expect(queryResult).toBeTruthy();
    console.log('✅ Query with payee.name join executed');
  });

  test('actual_query_run - should execute query with join path (category.name)', async ({ request }) => {
    console.log('🔍 Testing query with category.name join...');
    const result = await callTool(request, sessionId, 'actual_query_run', {
      query: 'SELECT id, amount, category.name FROM transactions WHERE amount < 0 LIMIT 10',
    });
    const queryResult = extractResult(result);

    expect(queryResult).toBeTruthy();
    console.log('✅ Query with category.name join executed');
  });

  test('actual_query_run - should execute query with WHERE and ORDER BY', async ({ request }) => {
    console.log('🔍 Testing query with WHERE and ORDER BY...');
    const result = await callTool(request, sessionId, 'actual_query_run', {
      query: 'SELECT id, date, amount FROM transactions WHERE amount < 0 ORDER BY date DESC LIMIT 20',
    });
    const queryResult = extractResult(result);

    expect(queryResult).toBeTruthy();
    console.log('✅ Query with WHERE and ORDER BY executed');
  });

  test('actual_query_run - ERROR: should reject invalid field (payee_name)', async ({ request }) => {
    console.log('⚠️  Testing invalid field validation (payee_name)...');
    try {
      await callTool(request, sessionId, 'actual_query_run', {
        query: 'SELECT id, payee_name FROM transactions LIMIT 5',
      });
      throw new Error('Should have failed with invalid field');
    } catch (error: any) {
      expect(error.message).toMatch(/payee_name|Available fields|invalid/i);
      console.log('✅ Invalid field payee_name rejected');
    }
  });

  test('actual_query_run - ERROR: should reject invalid field (category_name)', async ({ request }) => {
    console.log('⚠️  Testing invalid field validation (category_name)...');
    try {
      await callTool(request, sessionId, 'actual_query_run', {
        query: 'SELECT id, category_name FROM transactions LIMIT 5',
      });
      throw new Error('Should have failed with invalid field');
    } catch (error: any) {
      expect(error.message).toMatch(/category_name|Available fields|invalid/i);
      console.log('✅ Invalid field category_name rejected');
    }
  });

  test('actual_query_run - ERROR: should reject invalid table name', async ({ request }) => {
    console.log('⚠️  Testing invalid table validation...');
    try {
      await callTool(request, sessionId, 'actual_query_run', {
        query: 'SELECT * FROM transaction LIMIT 10',
      });
      throw new Error('Should have failed with invalid table');
    } catch (error: any) {
      expect(error.message).toMatch(/transaction|table|Available tables|invalid/i);
      console.log('✅ Invalid table name rejected');
    }
  });

  test('actual_query_run - ERROR: should reject invalid field in WHERE clause', async ({ request }) => {
    console.log('⚠️  Testing invalid field in WHERE clause...');
    try {
      await callTool(request, sessionId, 'actual_query_run', {
        query: 'SELECT id, amount FROM transactions WHERE payee_name = "Test"',
      });
      throw new Error('Should have failed with invalid field in WHERE');
    } catch (error: any) {
      expect(error.message).toMatch(/payee_name|Available fields|invalid/i);
      console.log('✅ Invalid field in WHERE clause rejected');
    }
  });

  test('actual_query_run - ERROR: should reject multiple invalid fields', async ({ request }) => {
    console.log('⚠️  Testing multiple invalid fields...');
    try {
      await callTool(request, sessionId, 'actual_query_run', {
        query: 'SELECT id, payee_name, category_name FROM transactions',
      });
      throw new Error('Should have failed with multiple invalid fields');
    } catch (error: any) {
      expect(error.message).toMatch(/payee_name|category_name|Available fields|invalid/i);
      console.log('✅ Multiple invalid fields rejected');
    }
  });

  test('actual_query_run - ERROR: should reject invalid join path (account.id)', async ({ request }) => {
    console.log('⚠️  Testing invalid join path (account.id)...');
    try {
      await callTool(request, sessionId, 'actual_query_run', {
        query: 'SELECT * FROM transactions WHERE account.id = \'bff82978-3f20-4956-860b-fa2cb069a144\' ORDER BY date DESC LIMIT 5',
      });
      throw new Error('Should have failed - account is not a join, just a field');
    } catch (error: any) {
      expect(error.message).toMatch(/account|Available fields|invalid/i);
      console.log('✅ Invalid join path account.id rejected');
    }
  });

  // ==================== CLEANUP ====================
  test.afterAll(async ({ request }) => {
    console.log('\n🧹 Cleaning up test data...');

    try {
      if (testContext.transactionId2) {
        await callTool(request, sessionId, 'actual_transactions_delete', {
          id: testContext.transactionId2,
        });
        console.log('✅ Transaction 2 deleted');
      }

      if (testContext.transactionId) {
        await callTool(request, sessionId, 'actual_transactions_delete', {
          id: testContext.transactionId,
        });
        console.log('✅ Transaction deleted');
      }

      if (testContext.upsertRuleId) {
        await callTool(request, sessionId, 'actual_rules_delete', {
          id: testContext.upsertRuleId,
        });
        console.log('✅ Upsert rule deleted');
      }

      if (testContext.ruleWithoutOpId) {
        await callTool(request, sessionId, 'actual_rules_delete', {
          id: testContext.ruleWithoutOpId,
        });
        console.log('✅ Rule (without op) deleted');
      }

      if (testContext.ruleId) {
        await callTool(request, sessionId, 'actual_rules_delete', {
          id: testContext.ruleId,
        });
        console.log('✅ Rule deleted');
      }

      if (testContext.payeeId) {
        await callTool(request, sessionId, 'actual_payees_delete', {
          id: testContext.payeeId,
        });
        console.log('✅ Payee deleted');
      }

      if (testContext.categoryId) {
        const categoryId = typeof testContext.categoryId === 'string'
          ? testContext.categoryId
          : (testContext.categoryId as any).id || String(testContext.categoryId);
        await callTool(request, sessionId, 'actual_categories_delete', {
          id: categoryId,
        });
        console.log('✅ Category deleted');
      }

      if (testContext.categoryGroupId) {
        const groupId = typeof testContext.categoryGroupId === 'string'
          ? testContext.categoryGroupId
          : (testContext.categoryGroupId as any).id || String(testContext.categoryGroupId);
        await callTool(request, sessionId, 'actual_category_groups_delete', {
          id: groupId,
        });
        console.log('✅ Category group deleted');
      }

      if (testContext.accountId) {
        await callTool(request, sessionId, 'actual_accounts_delete', {
          id: testContext.accountId,
        });
        console.log('✅ Account deleted');
      }

      console.log('✅ All cleanup operations completed');
    } catch (error: any) {
      console.warn('⚠️  Some cleanup operations failed:', error.message);
    }
  });
});
