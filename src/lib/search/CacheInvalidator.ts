/**
 * CacheInvalidator — maps write tool names to cache tags that must be
 * invalidated when that tool completes successfully.
 *
 * Also marks the search index as dirty so the next search triggers a re-sync.
 *
 * Usage (in the worker, after a tool call succeeds):
 *   invalidateAfterWrite('actual_transactions_create');
 */

import { getResponseCache } from './ResponseCache.js';
import { markSearchIndexDirty } from './syncState.js';
import { SearchIndex } from './SearchIndex.js';
import type { CacheTag } from './types.js';
import logger from '../../logger.js';
import { resolveBudgetSearchIndexDir } from '../budgetContext.js';

// ---------------------------------------------------------------------------
// Tool → tag mapping
// ---------------------------------------------------------------------------

const WRITE_TOOL_TAGS: Record<string, CacheTag[]> = {
  // Accounts
  actual_accounts_create: ['accounts'],
  actual_accounts_update: ['accounts'],
  actual_accounts_delete: ['accounts'],
  actual_accounts_close: ['accounts'],
  actual_accounts_reopen: ['accounts'],

  // Transactions
  actual_transactions_create: ['transactions', 'search'],
  actual_transactions_update: ['transactions', 'search'],
  actual_transactions_update_batch: ['transactions', 'search'],
  actual_transactions_delete: ['transactions', 'search'],
  actual_transactions_import: ['transactions', 'search'],

  // Categories
  actual_categories_create: ['categories', 'search'],
  actual_categories_update: ['categories', 'search'],
  actual_categories_delete: ['categories', 'search'],

  // Category groups
  actual_category_groups_create: ['category_groups', 'categories'],
  actual_category_groups_update: ['category_groups', 'categories'],
  actual_category_groups_delete: ['category_groups', 'categories'],

  // Payees
  actual_payees_create: ['payees', 'search'],
  actual_payees_update: ['payees', 'search'],
  actual_payees_delete: ['payees', 'search'],
  actual_payees_merge: ['payees', 'search'],

  // Schedules
  actual_schedules_create: ['schedules'],
  actual_schedules_update: ['schedules'],
  actual_schedules_delete: ['schedules'],

  // Rules
  actual_rules_create: ['rules'],
  actual_rules_create_or_update: ['rules'],
  actual_rules_update: ['rules'],
  actual_rules_delete: ['rules'],

  // Budgets
  actual_budgets_setAmount: ['budgets'],
  actual_budgets_transfer: ['budgets'],
  actual_budgets_setCarryover: ['budgets'],
  actual_budgets_holdForNextMonth: ['budgets'],
  actual_budgets_resetHold: ['budgets'],
  actual_budget_updates_batch: ['budgets'],

  // Bank sync
  actual_bank_sync: ['transactions', 'accounts', 'search'],
};

function resolveSearchDataDir(): string {
  return resolveBudgetSearchIndexDir(
    process.env.SEARCH_INDEX_DIR
      || process.env.MCP_BRIDGE_DATA_DIR
      || './actual-data',
  );
}

function bumpPersistedDirtyGeneration(): void {
  let tempIndex: SearchIndex | null = null;
  try {
    tempIndex = new SearchIndex(resolveSearchDataDir());
    tempIndex.open();
    tempIndex.bumpDirtyGeneration();
  } catch (err) {
    logger.warn(
      `[CacheInvalidator] Failed to persist dirty generation: ${err instanceof Error ? err.message : String(err)}`,
    );
  } finally {
    try {
      tempIndex?.close();
    } catch {
      // best-effort cleanup
    }
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Invalidate cache entries associated with a write tool.
 * Call this after the tool call succeeds.
 */
export function invalidateAfterWrite(toolName: string): void {
  const tags = WRITE_TOOL_TAGS[toolName];
  if (!tags || tags.length === 0) return;

  const cache = getResponseCache();
  const count = cache.invalidateByTags(tags);

  // Mark search index for re-sync on next query
  if (tags.includes('search') || tags.includes('transactions')) {
    markSearchIndexDirty();
    bumpPersistedDirtyGeneration();
  }

  if (count > 0) {
    logger.debug(
      `[CacheInvalidator] Tool "${toolName}" → invalidated ${count} entries (tags: ${tags.join(', ')})`,
    );
  }
}

/**
 * Check if a tool name is a known write tool.
 */
export function isWriteTool(toolName: string): boolean {
  return toolName in WRITE_TOOL_TAGS;
}
