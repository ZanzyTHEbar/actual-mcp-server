import { z } from 'zod';
import { wrapToolCall } from '../lib/wrapToolCall.js';
import type { ToolDefinition } from '../../types/tool.d.js';
import adapter from '../lib/actual-adapter.js';

const InputSchema = z.object({}).strict();

const tool: ToolDefinition = {
  name: 'actual_server_get_version',
  description:
    'Get the version of the connected Actual Budget server instance. This is the Actual server version, not the MCP server version.',
  inputSchema: InputSchema,
  call: wrapToolCall(async (_args: unknown, _meta?: unknown) => {
    return adapter.getServerVersion();
  }),
};

export default tool;
