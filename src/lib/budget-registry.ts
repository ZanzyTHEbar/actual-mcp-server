/**
 * Budget Registry — pre-configured multi-budget, multi-server support.
 *
 * Budgets are declared via environment variables:
 *
 *   # Default budget (always present, from existing ACTUAL_* vars)
 *   BUDGET_DEFAULT_NAME=My Budget        # optional, defaults to "Default"
 *   ACTUAL_SERVER_URL=http://actual:5006
 *   ACTUAL_PASSWORD=secret
 *   ACTUAL_BUDGET_SYNC_ID=uuid-here
 *   ACTUAL_BUDGET_PASSWORD=              # optional, for E2E-encrypted budgets
 *
 *   # Additional named budgets — each group can point to a different server
 *   BUDGET_1_NAME=Shared Family Account
 *   BUDGET_1_SERVER_URL=http://actual:5006    # optional, falls back to ACTUAL_SERVER_URL
 *   BUDGET_1_PASSWORD=secret                   # optional, falls back to ACTUAL_PASSWORD
 *   BUDGET_1_SYNC_ID=uuid-here                 # required
 *   BUDGET_1_ENCRYPTION_PASSWORD=              # optional
 *
 *   BUDGET_2_NAME=Office
 *   BUDGET_2_SERVER_URL=http://actual-office:5006
 *   BUDGET_2_PASSWORD=officepassword
 *   BUDGET_2_SYNC_ID=uuid-here
 *
 * The AI uses `actual_budgets_list_available` to see all configured budgets,
 * then `actual_budgets_switch` with the budget name to switch between them.
 */

import { createHash } from 'crypto';

export interface BudgetConfig {
  name: string;
  serverUrl: string;
  password: string;
  syncId: string;
  encryptionPassword?: string;
}

export interface BudgetHandle extends BudgetConfig {
  budgetKey: string;
}

export interface BudgetDefaults {
  serverUrl: string;
  password: string;
  syncId: string;
  encryptionPassword?: string;
}

function normalizeBudgetName(name: string): string {
  return name.trim().toLocaleLowerCase();
}

function assertUniqueBudgetName(
  registry: Map<string, BudgetConfig>,
  name: string,
  sourceLabel: string,
): void {
  const normalized = normalizeBudgetName(name);
  if (registry.has(normalized)) {
    throw new Error(
      `Duplicate budget name "${name}" from ${sourceLabel}. Budget names must be unique case-insensitively.`,
    );
  }
}

export function createBudgetKey(serverUrl: string, syncId: string): string {
  return createHash('sha256')
    .update(`${serverUrl}|${syncId}`)
    .digest('hex')
    .slice(0, 16);
}

export function toBudgetHandle(config: BudgetConfig): BudgetHandle {
  return {
    ...config,
    budgetKey: createBudgetKey(config.serverUrl, config.syncId),
  };
}

export function buildDefaultBudgetDefaults(env: NodeJS.ProcessEnv): BudgetDefaults {
  return {
    serverUrl: env.ACTUAL_SERVER_URL || 'http://localhost:5006',
    password: env.ACTUAL_PASSWORD || '',
    syncId: env.ACTUAL_BUDGET_SYNC_ID || '',
    encryptionPassword: env.ACTUAL_BUDGET_PASSWORD,
  };
}

/**
 * Parse the budget registry from environment variables.
 * Always includes the default budget from the provided defaults (ACTUAL_* vars).
 * Additional budgets are read from sequential BUDGET_n_* groups.
 */
export function parseBudgetRegistry(
  env: NodeJS.ProcessEnv,
  defaults: BudgetDefaults,
): Map<string, BudgetConfig> {
  const registry = new Map<string, BudgetConfig>();

  const defaultName = env.BUDGET_DEFAULT_NAME ?? 'Default';
  if (defaults.syncId) {
    assertUniqueBudgetName(registry, defaultName, 'default budget');
    registry.set(normalizeBudgetName(defaultName), {
      name: defaultName,
      serverUrl: defaults.serverUrl,
      password: defaults.password,
      syncId: defaults.syncId,
      encryptionPassword: defaults.encryptionPassword,
    });
  }

  let i = 1;
  while (env[`BUDGET_${i}_NAME`]) {
    const prefix = `BUDGET_${i}_`;
    const name = env[`${prefix}NAME`] as string;
    const serverUrl = env[`${prefix}SERVER_URL`] ?? defaults.serverUrl;
    const password = env[`${prefix}PASSWORD`] ?? defaults.password;
    const syncId = env[`${prefix}SYNC_ID`];
    if (!syncId) {
      throw new Error(
        `BUDGET_${i}_SYNC_ID is required when BUDGET_${i}_NAME="${name}" is set`,
      );
    }
    assertUniqueBudgetName(registry, name, `BUDGET_${i}_NAME`);
    registry.set(normalizeBudgetName(name), {
      name,
      serverUrl,
      password,
      syncId,
      encryptionPassword: env[`${prefix}ENCRYPTION_PASSWORD`],
    });
    i++;
  }

  if (registry.size === 0) {
    throw new Error(
      'No valid budgets configured. Set ACTUAL_BUDGET_SYNC_ID or configure at least one BUDGET_n_* entry.',
    );
  }

  return registry;
}

export function resolveBudgetByName(
  registry: Map<string, BudgetConfig>,
  requestedName: string,
): { match: BudgetHandle | null; matches: BudgetHandle[] } {
  const normalized = normalizeBudgetName(requestedName);
  const exact = registry.get(normalized);
  if (exact) {
    return { match: toBudgetHandle(exact), matches: [toBudgetHandle(exact)] };
  }

  const matches = Array.from(registry.entries())
    .filter(([name]) => name.includes(normalized))
    .map(([, config]) => toBudgetHandle(config));

  return {
    match: matches.length === 1 ? matches[0] : null,
    matches,
  };
}

export function listBudgetHandles(registry: Map<string, BudgetConfig>): BudgetHandle[] {
  return Array.from(registry.values()).map(toBudgetHandle);
}
