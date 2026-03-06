import { z } from 'zod';
import { wrapToolCall } from '../lib/wrapToolCall.js';
import type { ToolDefinition } from '../../types/tool.d.js';
import actualToolsManager from '../actualToolsManager.js';
import { sessionWorkerManager } from '../lib/SessionWorkerManager.js';
import { requestContext } from '../lib/requestContext.js';
import { normalizeToolName } from '../lib/toolNameNormalization.js';

const InputSchema = z.object({
  toolName: z.string().min(1).describe(
    'The exact tool name to invoke (e.g., "actual_transactions_get", "actual_rules_create_or_update"). ' +
    'Use actual_tool_registry to discover available tool names.',
  ),
  arguments: z.record(z.unknown()).optional().default({}).describe(
    'Arguments to pass to the tool. Must match the tool\'s inputSchema. ' +
    'Use actual_tool_registry to see the required/optional parameters for each tool.',
  ),
});

const tool: ToolDefinition = {
  name: 'actual_tool_call',
  description: `Execute any Actual Budget tool by name with the specified arguments.

This is the universal execution endpoint. First use actual_tool_registry to discover available tools and their parameters, then use this tool to invoke them.

IMPORTANT:
- The "toolName" must be an exact match from actual_tool_registry (e.g., "actual_accounts_list", not "accounts_list").
- The "arguments" object must conform to the tool's inputSchema (see actual_tool_registry for schema details).
- Results are returned directly from the underlying tool.

Error handling:
- Unknown tool name → clear error with suggestion to check actual_tool_registry
- Invalid arguments → Zod validation error with details about what's wrong
- Tool execution error → original error message from the underlying tool

Example:
  { toolName: "actual_accounts_list", arguments: {} }
  { toolName: "actual_transactions_get", arguments: { accountId: "uuid-here", startDate: "2025-01-01" } }
  { toolName: "actual_rules_create_or_update", arguments: { conditions: [...], actions: [...] } }`,
  inputSchema: InputSchema,
  call: wrapToolCall(async (args: unknown, _meta?: unknown) => {
    const input = InputSchema.parse(args || {});
    const { toolName, arguments: toolArgs } = input;
    const normalizedToolName = normalizeToolName(toolName);
    if (normalizedToolName === 'actual_tool_call') {
      throw new Error('actual_tool_call cannot invoke itself');
    }

    // Verify the tool exists
    const targetTool = actualToolsManager.getTool(normalizedToolName);
    if (!targetTool) {
      const allNames = actualToolsManager.getToolNames();
      // Find close matches for helpful suggestions
      const suggestions = allNames
        .filter((n) => {
          const parts = normalizedToolName.toLowerCase().split('_');
          return parts.some((p) => p.length > 2 && n.toLowerCase().includes(p));
        })
        .slice(0, 5);

      const suggestionText = suggestions.length > 0
        ? ` Did you mean one of: ${suggestions.join(', ')}?`
        : ' Use actual_tool_registry to see all available tools.';

      throw new Error(`Unknown tool: "${toolName}".${suggestionText}`);
    }

    // Delegate through the session worker manager for proper write coordination.
    // Fall back to actualToolsManager.callTool() if no session context is available
    // (e.g., during testing or non-HTTP transports).
    const ctx = requestContext.getStore();
    const sessionId = ctx?.sessionId;
    const executesGlobally = normalizedToolName === 'actual_session_list' || normalizedToolName === 'actual_session_close';

    if (sessionId && !executesGlobally) {
      // Route through session worker manager for write coordination
      const result = await sessionWorkerManager.executeTool(sessionId, normalizedToolName, toolArgs);
      return result;
    }

    // Fallback/global execution (used for session management and non-session transports)
    const result = await actualToolsManager.callTool(normalizedToolName, toolArgs);
    return result;
  }),
};

export default tool;
