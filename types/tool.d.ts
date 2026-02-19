import { ZodTypeAny } from 'zod';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';

export interface ToolDefinition {
  name: string;
  description: string;
  inputSchema: ZodTypeAny;
  // Use `unknown` for external inputs; tool `call` implementations should parse with zod
  call: (args: unknown, meta?: unknown) => Promise<CallToolResult>;
}
