/**
 * Canonical tool-name normalization.
 *
 * Keep this map small and explicit: it is only for backward-compatible aliases
 * that were previously exposed in docs/tests or accepted by older builds.
 */
const LEGACY_TOOL_NAME_ALIASES: Readonly<Record<string, string>> = Object.freeze({
  actual_budgets_updates_batch: 'actual_budget_updates_batch',
});

export function normalizeToolName(toolName: string): string {
  return LEGACY_TOOL_NAME_ALIASES[toolName] ?? toolName;
}

export function getLegacyToolNameAliases(): Readonly<Record<string, string>> {
  return LEGACY_TOOL_NAME_ALIASES;
}
