/**
 * Budget-scoped sync state for the search index.
 *
 * Tracks which budget IDs have been synced in the current process lifetime.
 * On restart, all budgets are considered un-synced (conservative approach).
 */

const _syncedBudgets = new Set<string>();

let _activeBudgetId: string | null = null;

export function setActiveBudget(budgetId: string): void {
  _activeBudgetId = budgetId;
}

export function getActiveBudget(): string | null {
  return _activeBudgetId;
}

export function markSearchIndexDirty(budgetId?: string): void {
  const id = budgetId ?? _activeBudgetId;
  if (id) {
    _syncedBudgets.delete(id);
  } else {
    _syncedBudgets.clear();
  }
}

export function isSearchIndexSynced(budgetId?: string): boolean {
  const id = budgetId ?? _activeBudgetId;
  if (!id) return false;
  return _syncedBudgets.has(id);
}

export function markSearchIndexSynced(budgetId?: string): void {
  const id = budgetId ?? _activeBudgetId;
  if (id) {
    _syncedBudgets.add(id);
  }
}
