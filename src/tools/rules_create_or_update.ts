import { z } from 'zod';
import { wrapToolCall } from '../lib/wrapToolCall.js';
import type { ToolDefinition } from '../../types/tool.d.js';
import adapter from '../lib/actual-adapter.js';

// Reuse the same condition/action schemas as rules_create
const ConditionSchema = z.object({
  field: z.string().describe('Field to match (e.g., "payee", "notes", "amount", "category", "imported_payee")'),
  op: z.string().describe('Operation (e.g., "is", "contains", "isapprox", "gte", "lte")'),
  value: z.union([z.string(), z.number()]).describe('Value to match against'),
  type: z.string().optional().describe('Type of condition (e.g., "string", "number", "id")'),
});

const ActionSchema = z.object({
  op: z.string()
    .default('set')
    .describe('Operation to perform. Options: "set", "set-split-amount", "link-schedule", "prepend-notes", "append-notes"'),
  field: z.string()
    .optional()
    .describe('Field to modify — required for "set" op. Options: "category", "payee", "notes", "cleared", "account"'),
  value: z.union([z.string(), z.number(), z.boolean(), z.object({}).passthrough()])
    .describe('Value to assign. Use UUIDs for id-type fields, text for strings, numbers for amounts'),
  type: z.string()
    .optional()
    .describe('Value type hint: "id", "string", "number", "boolean"'),
  options: z.object({}).passthrough().optional().describe('Additional options for the action'),
});

const FIELD_OPERATORS: Record<string, { type: string; operators: string[] }> = {
  'imported_payee': { type: 'string', operators: ['contains', 'matches', 'doesNotContain', 'is', 'isNot'] },
  'payee': { type: 'id', operators: ['is', 'isNot', 'oneOf', 'notOneOf'] },
  'account': { type: 'id', operators: ['is', 'isNot', 'oneOf', 'notOneOf'] },
  'category': { type: 'id', operators: ['is', 'isNot', 'oneOf', 'notOneOf'] },
  'notes': { type: 'string', operators: ['contains', 'matches', 'doesNotContain', 'is', 'isNot'] },
  'description': { type: 'string', operators: ['contains', 'matches', 'doesNotContain', 'is', 'isNot'] },
  'amount': { type: 'number', operators: ['is', 'gte', 'lte', 'gt', 'lt', 'isapprox'] },
  'date': { type: 'date', operators: ['is', 'gte', 'lte', 'gt', 'lt'] },
};

const InputSchema = z.object({
  stage: z.enum(['pre', 'post']).optional().default('pre').describe('When to apply the rule — "pre" or "post"'),
  conditionsOp: z.enum(['and', 'or']).optional().default('and').describe('How to combine multiple conditions'),
  conditions: z.array(ConditionSchema).describe('Array of conditions that must be met'),
  actions: z.array(ActionSchema).describe('Array of actions to perform when conditions match'),
});

/**
 * Normalize a condition/action for comparison by sorting keys and stripping
 * undefined values. This lets us do a stable JSON comparison.
 */
function canonicalize(obj: Record<string, unknown>): string {
  const sorted: Record<string, unknown> = {};
  for (const key of Object.keys(obj).sort()) {
    if (obj[key] !== undefined) sorted[key] = obj[key];
  }
  return JSON.stringify(sorted);
}

/**
 * Check if two rules have semantically equivalent conditions.
 * We match on the set of (field, op, value) triples in the same conditionsOp mode.
 */
function conditionsMatch(
  existingConditions: unknown[],
  existingConditionsOp: string | undefined,
  newConditions: z.infer<typeof ConditionSchema>[],
  newConditionsOp: string,
): boolean {
  if ((existingConditionsOp || 'and') !== newConditionsOp) return false;
  if (!Array.isArray(existingConditions)) return false;
  if (existingConditions.length !== newConditions.length) return false;

  const existingSet = new Set(
    existingConditions.map((c: unknown) => {
      const cond = c as Record<string, unknown>;
      return canonicalize({ field: cond.field, op: cond.op, value: cond.value });
    }),
  );

  const newSet = new Set(
    newConditions.map((c) => canonicalize({ field: c.field, op: c.op, value: c.value })),
  );

  if (existingSet.size !== newSet.size) return false;
  for (const item of newSet) {
    if (!existingSet.has(item)) return false;
  }
  return true;
}

const tool: ToolDefinition = {
  name: 'actual_rules_create_or_update',
  description: `Create a rule if no matching rule exists, or update the existing rule if one with the same conditions already exists. This prevents duplicate rules.

Matching logic: A rule is considered a "match" when it has the same set of conditions (field + op + value triples) and the same conditionsOp ("and"/"or").

When a match is found, the rule's actions (and optionally stage) are REPLACED with the new values. When no match exists, a new rule is created.

IMPORTANT Field Types:
- "imported_payee" (string) — text matching. Supports: contains, matches, doesNotContain, is, isNot
- "payee" (ID) — exact payee UUID. Supports: is, isNot, oneOf, notOneOf
- "account", "category" (ID) — UUID matching. Supports: is, isNot, oneOf, notOneOf
- "notes", "description" (string) — text matching. Supports: contains, matches, doesNotContain, is, isNot
- "amount", "date" (number/date) — supports: is, gte, lte, gt, lt

Returns: { id, created: boolean } — created=true if new rule, false if existing rule was updated.`,
  inputSchema: InputSchema,
  call: wrapToolCall(async (args: unknown, _meta?: unknown) => {
    try {
      const input = InputSchema.parse(args || {});

      // ── Validate conditions ──
      for (const condition of input.conditions) {
        const fieldInfo = FIELD_OPERATORS[condition.field];
        if (fieldInfo && !fieldInfo.operators.includes(condition.op)) {
          throw new Error(
            `Invalid operator "${condition.op}" for field "${condition.field}". ` +
            `Field "${condition.field}" is a ${fieldInfo.type} field and only supports: ${fieldInfo.operators.join(', ')}.`,
          );
        }
        if (condition.field === 'payee' && typeof condition.value === 'string' && !condition.value.match(/^[0-9a-f-]{36}$/i)) {
          throw new Error(
            `Field "payee" expects a UUID, but got "${condition.value}". Use "imported_payee" for text matching.`,
          );
        }
        if (['account', 'category'].includes(condition.field) && typeof condition.value === 'string' && !condition.value.match(/^[0-9a-f-]{36}$/i)) {
          throw new Error(
            `Field "${condition.field}" expects a UUID, but got text "${condition.value}".`,
          );
        }
        if (['oneOf', 'notOneOf'].includes(condition.op) && !Array.isArray(condition.value)) {
          throw new Error(`Operator "${condition.op}" expects an array of values.`);
        }
      }

      // ── Validate actions ──
      for (const action of input.actions) {
        if (action.op === 'set' && !action.field) {
          throw new Error('Action with op="set" requires a "field" property.');
        }
        if (action.op === 'set' && action.field) {
          for (const idField of ['category', 'payee', 'account'] as const) {
            if (action.field === idField && typeof action.value === 'string' && !action.value.match(/^[0-9a-f-]{36}$/i)) {
              throw new Error(`Action field "${idField}" expects a UUID, but got "${action.value}".`);
            }
          }
        }
        if (['append-notes', 'prepend-notes'].includes(action.op) && typeof action.value !== 'string') {
          throw new Error(`Action "${action.op}" requires a string value.`);
        }
      }

      // ── Fetch existing rules and look for a match ──
      const existingRules = await adapter.getRules();
      let matchedRule: (Record<string, unknown> & { id: string }) | null = null;

      for (const rule of existingRules) {
        const r = rule as Record<string, unknown>;
        if (!r.id || typeof r.id !== 'string') continue;

        const existingConditions = Array.isArray(r.conditions) ? r.conditions : [];
        const existingConditionsOp = (r.conditionsOp as string) || 'and';

        if (conditionsMatch(existingConditions, existingConditionsOp, input.conditions, input.conditionsOp)) {
          matchedRule = r as Record<string, unknown> & { id: string };
          break;
        }
      }

      const ruleData = JSON.parse(JSON.stringify(input)); // deep clone for API call

      if (matchedRule) {
        // ── UPDATE existing rule ──
        await adapter.updateRule(matchedRule.id, {
          stage: ruleData.stage,
          conditionsOp: ruleData.conditionsOp,
          conditions: ruleData.conditions,
          actions: ruleData.actions,
        });
        return { id: matchedRule.id, created: false };
      } else {
        // ── CREATE new rule ──
        const ruleId = await adapter.createRule(ruleData);
        return { id: ruleId, created: true };
      }
    } catch (error) {
      if (error instanceof z.ZodError) {
        const fieldErrors = error.issues.map((e: z.ZodIssue) => `${e.path.join('.')}: ${e.message}`).join('; ');
        throw new Error(`Invalid rule data: ${fieldErrors}`);
      }
      throw error;
    }
  }),
};

export default tool;
