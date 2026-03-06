import { AsyncLocalStorage } from 'async_hooks';
import path from 'path';
import type { BudgetHandle } from './budget-registry.js';

type BudgetContextData = {
  budget: BudgetHandle;
};

const budgetContext = new AsyncLocalStorage<BudgetContextData>();

function fallbackBudgetHandle(): BudgetHandle {
  const serverUrl = process.env.ACTUAL_SERVER_URL || 'http://localhost:5006';
  const syncId = process.env.ACTUAL_BUDGET_SYNC_ID || '__default__';
  const budgetKey = `fallback-${syncId}`;
  return {
    name: process.env.BUDGET_DEFAULT_NAME || 'Default',
    serverUrl,
    password: process.env.ACTUAL_PASSWORD || '',
    syncId,
    encryptionPassword: process.env.ACTUAL_BUDGET_PASSWORD,
    budgetKey,
  };
}

export function withBudgetContext<T>(budget: BudgetHandle, fn: () => T): T {
  return budgetContext.run({ budget }, fn);
}

export function getCurrentBudgetHandle(): BudgetHandle {
  return budgetContext.getStore()?.budget ?? fallbackBudgetHandle();
}

export function getCurrentBudgetKey(): string {
  return getCurrentBudgetHandle().budgetKey;
}

export function getCurrentBudgetId(): string {
  return getCurrentBudgetHandle().syncId;
}

export function budgetCacheKey(baseKey: string): string {
  return `budget:${getCurrentBudgetKey()}:${baseKey}`;
}

export function serverCacheKey(baseKey: string): string {
  const budget = getCurrentBudgetHandle();
  return `server:${budget.serverUrl}:${baseKey}`;
}

export function resolveBudgetSearchIndexDir(baseDir?: string): string {
  const root = baseDir
    || process.env.SEARCH_INDEX_DIR
    || process.env.MCP_BRIDGE_DATA_DIR
    || './actual-data';
  return path.join(root, getCurrentBudgetKey());
}
