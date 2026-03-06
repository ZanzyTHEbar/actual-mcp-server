/**
 * Budget-scoped sync state for the search index.
 *
 * Uses generation counters:
 * - dirtyGeneration increments when writes invalidate search freshness.
 * - syncedGeneration tracks the last dirty generation that was fully indexed.
 *
 * A budget is considered synced iff syncedGeneration >= dirtyGeneration.
 */

type BudgetSyncState = {
  dirtyGeneration: number;
  syncedGeneration: number;
};

const _budgetSyncState = new Map<string, BudgetSyncState>();

let _activeBudgetId: string | null = null;

export function setActiveBudget(budgetId: string): void {
  _activeBudgetId = budgetId;
}

export function getActiveBudget(): string | null {
  return _activeBudgetId;
}

function getOrInitState(budgetId: string): BudgetSyncState {
  const existing = _budgetSyncState.get(budgetId);
  if (existing) return existing;
  const initial: BudgetSyncState = { dirtyGeneration: 0, syncedGeneration: 0 };
  _budgetSyncState.set(budgetId, initial);
  return initial;
}

export function hydrateSearchSyncState(
  budgetId: string,
  dirtyGeneration: number,
  syncedGeneration: number,
): void {
  _budgetSyncState.set(budgetId, {
    dirtyGeneration: Math.max(0, dirtyGeneration),
    syncedGeneration: Math.max(0, syncedGeneration),
  });
}

export function getSearchSyncGenerations(
  budgetId?: string,
): { dirtyGeneration: number; syncedGeneration: number } | null {
  const id = budgetId ?? _activeBudgetId;
  if (!id) return null;
  const state = getOrInitState(id);
  return {
    dirtyGeneration: state.dirtyGeneration,
    syncedGeneration: state.syncedGeneration,
  };
}

export function markSearchIndexDirty(budgetId?: string): number {
  const id = budgetId ?? _activeBudgetId;
  if (!id) return 0;
  const state = getOrInitState(id);
  state.dirtyGeneration += 1;
  return state.dirtyGeneration;
}

export function isSearchIndexSynced(budgetId?: string): boolean {
  const id = budgetId ?? _activeBudgetId;
  if (!id) return false;
  const state = getOrInitState(id);
  return state.syncedGeneration >= state.dirtyGeneration;
}

export function markSearchIndexSynced(budgetId?: string): void {
  const id = budgetId ?? _activeBudgetId;
  if (!id) return;
  const state = getOrInitState(id);
  state.syncedGeneration = state.dirtyGeneration;
}

export function markSearchIndexSyncedIfGeneration(
  expectedDirtyGeneration: number,
  budgetId?: string,
): boolean {
  const id = budgetId ?? _activeBudgetId;
  if (!id) return false;
  const state = getOrInitState(id);
  if (state.dirtyGeneration !== expectedDirtyGeneration) return false;
  state.syncedGeneration = expectedDirtyGeneration;
  return true;
}

export function resetSearchSyncStateForTests(): void {
  _budgetSyncState.clear();
  _activeBudgetId = null;
}
