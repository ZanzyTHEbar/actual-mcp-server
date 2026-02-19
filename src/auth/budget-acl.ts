import logger from '../logger.js';
import config from '../config.js';
import type { AuthIdentity } from './types.js';

/**
 * Budget Access Control List.
 *
 * Configured via AUTH_BUDGET_ACL env var (JSON string):
 *   {"user@example.com": ["budget-sync-id-1", "budget-sync-id-2"]}
 *   {"*": ["*"]}  — wildcard: all users can access all budgets
 *
 * If AUTH_BUDGET_ACL is not set (or empty), all users can access all budgets (open access).
 * If AUTH_PROVIDER=none, ACL is not enforced.
 */

type AclMap = Record<string, string[]>;

let cachedAcl: AclMap | null = null;

function getAcl(): AclMap | null {
  if (cachedAcl !== undefined && cachedAcl !== null) return cachedAcl;

  const raw = config.AUTH_BUDGET_ACL;
  if (!raw) {
    cachedAcl = null;
    return null;
  }

  try {
    cachedAcl = JSON.parse(raw) as AclMap;
    logger.info(`[ACL] Loaded budget ACL for ${Object.keys(cachedAcl).length} user(s)`);
    return cachedAcl;
  } catch (err) {
    logger.error(`[ACL] Failed to parse AUTH_BUDGET_ACL: ${err}`);
    cachedAcl = null;
    return null;
  }
}

/**
 * Check if an authenticated user is allowed to access a specific budget.
 *
 * @param identity - The authenticated user identity
 * @param budgetSyncId - The budget's sync ID
 * @returns true if allowed, false if denied
 */
export function canAccessBudget(identity: AuthIdentity, budgetSyncId: string): boolean {
  const acl = getAcl();

  // No ACL configured → open access
  if (!acl) return true;

  // Check wildcard
  if (acl['*']?.includes('*') || acl['*']?.includes(budgetSyncId)) {
    return true;
  }

  // Check by userId
  const userBudgets = acl[identity.userId];
  if (userBudgets) {
    if (userBudgets.includes('*') || userBudgets.includes(budgetSyncId)) {
      return true;
    }
  }

  // Check by email if different from userId
  if (identity.email && identity.email !== identity.userId) {
    const emailBudgets = acl[identity.email];
    if (emailBudgets) {
      if (emailBudgets.includes('*') || emailBudgets.includes(budgetSyncId)) {
        return true;
      }
    }
  }

  // Check by group membership
  if (identity.groups) {
    for (const group of identity.groups) {
      const groupKey = `group:${group}`;
      const groupBudgets = acl[groupKey];
      if (groupBudgets) {
        if (groupBudgets.includes('*') || groupBudgets.includes(budgetSyncId)) {
          return true;
        }
      }
    }
  }

  logger.warn(`[ACL] Access denied: user=${identity.userId} budget=${budgetSyncId}`);
  return false;
}

/**
 * Get the list of budget sync IDs a user is allowed to access.
 * Returns null if no ACL is configured (open access).
 */
export function getAllowedBudgets(identity: AuthIdentity): string[] | null {
  const acl = getAcl();
  if (!acl) return null;

  const budgets = new Set<string>();

  // Collect from wildcard
  if (acl['*']) {
    for (const b of acl['*']) budgets.add(b);
  }

  // Collect from userId
  if (acl[identity.userId]) {
    for (const b of acl[identity.userId]) budgets.add(b);
  }

  // Collect from email
  if (identity.email && identity.email !== identity.userId && acl[identity.email]) {
    for (const b of acl[identity.email]) budgets.add(b);
  }

  // Collect from groups
  if (identity.groups) {
    for (const group of identity.groups) {
      const groupBudgets = acl[`group:${group}`];
      if (groupBudgets) {
        for (const b of groupBudgets) budgets.add(b);
      }
    }
  }

  return [...budgets];
}

/** Reset cached ACL (for testing). */
export function resetAclCache(): void {
  cachedAcl = null;
}
