import { z } from 'zod';
import { wrapToolCall } from '../lib/wrapToolCall.js';
import type { ToolDefinition } from '../../types/tool.d.js';
import { lookupEntityByName, type LookupEntityType } from '../lib/lookupByName.js';
import { toErrorResult } from '../lib/toolResult.js';

const ENTITY_TYPES = ['accounts', 'schedules', 'categories', 'payees'] as const;

const InputSchema = z.object({
  type: z.enum(ENTITY_TYPES).describe('Entity type to resolve by name'),
  name: z.string().min(1, 'Name cannot be empty').describe('Display name to resolve to an ID'),
});

function getListTool(type: LookupEntityType): string {
  switch (type) {
    case 'accounts':
      return 'actual_accounts_list';
    case 'categories':
      return 'actual_categories_get';
    case 'payees':
      return 'actual_payees_get';
    case 'schedules':
      return 'actual_schedules_get';
  }
}

const tool: ToolDefinition = {
  name: 'actual_get_id_by_name',
  description:
    'Resolve an account, category, payee, or schedule name to its ID. Returns an error if there is no exact match or if the name is ambiguous.',
  inputSchema: InputSchema,
  call: wrapToolCall(async (args: unknown, _meta?: unknown) => {
    const input = InputSchema.parse(args || {});
    const result = await lookupEntityByName(input.type, input.name);

    if (result.status === 'found') {
      return {
        id: result.match.id,
        type: input.type,
        name: result.match.name,
      };
    }

    if (result.status === 'ambiguous') {
      return toErrorResult({
        message: `Multiple ${input.type} matched "${input.name}". Use the exact ID instead.`,
        matches: result.matches,
      });
    }

    return toErrorResult({
      message: `${input.type} named "${input.name}" was not found. Use ${getListTool(input.type)} to inspect valid names.`,
      available: result.available,
    });
  }),
};

export default tool;
