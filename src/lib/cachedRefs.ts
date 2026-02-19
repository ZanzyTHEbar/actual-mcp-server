/**
 * Cached reference-data helpers.
 *
 * These wrap `safeGetOrFetch` so every tool that needs accounts, payees,
 * categories, or category-groups gets a warm in-memory hit after the first
 * call (10 min TTL, tag-invalidated on writes).
 *
 * Convention: cache keys use the `ref:` prefix.
 */

import { safeGetOrFetch } from './search/index.js';
import type { CacheTag } from './search/types.js';
import adapter from './actual-adapter.js';

// ---------------------------------------------------------------------------
// Helpers — typed wrappers around safeGetOrFetch
// ---------------------------------------------------------------------------

const REF_TTL_MS = 10 * 60_000; // 10 minutes

export async function getCachedAccounts(): Promise<any[]> {
  return safeGetOrFetch('ref:accounts', {
    ttlMs: REF_TTL_MS,
    tags: ['accounts'] as CacheTag[],
    fetcher: () => adapter.getAccounts(),
  });
}

export async function getCachedPayees(): Promise<any[]> {
  return safeGetOrFetch('ref:payees', {
    ttlMs: REF_TTL_MS,
    tags: ['payees'] as CacheTag[],
    fetcher: () => adapter.getPayees(),
  });
}

export async function getCachedCategories(): Promise<any[]> {
  return safeGetOrFetch('ref:categories', {
    ttlMs: REF_TTL_MS,
    tags: ['categories'] as CacheTag[],
    fetcher: () => adapter.getCategories(),
  });
}

export async function getCachedCategoryGroups(): Promise<any[]> {
  return safeGetOrFetch('ref:categoryGroups', {
    ttlMs: REF_TTL_MS,
    tags: ['categories'] as CacheTag[],
    fetcher: () => adapter.getCategoryGroups(),
  });
}

// ---------------------------------------------------------------------------
// Convenience map builders — avoids rebuilding maps on every call
// ---------------------------------------------------------------------------

export async function getAccountMap(): Promise<Map<string, string>> {
  const accounts = await getCachedAccounts();
  return new Map(accounts.map((a: any) => [a.id, a.name ?? '']));
}

export async function getPayeeMap(): Promise<Map<string, string>> {
  const payees = await getCachedPayees();
  return new Map(payees.map((p: any) => [p.id, p.name ?? '']));
}

export async function getCategoryMap(): Promise<Map<string, any>> {
  const categories = await getCachedCategories();
  return new Map(categories.map((c: any) => [c.id, c]));
}

export async function getCategoryGroupMap(): Promise<Map<string, any>> {
  const groups = await getCachedCategoryGroups();
  return new Map(groups.map((g: any) => [g.id, g]));
}
