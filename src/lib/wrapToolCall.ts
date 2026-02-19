import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { ensureCallToolResult } from './toolResult.js';

export function wrapToolCall(
  fn: (args: unknown, meta?: unknown) => Promise<unknown>
): (args: unknown, meta?: unknown) => Promise<CallToolResult> {
  return async (args: unknown, meta?: unknown) => {
    const result = await fn(args, meta);
    return ensureCallToolResult(result);
  };
}
