/**
 * Cached reference-data helpers.
 *
 * These wrap `safeGetOrFetch` so every tool that needs accounts, payees,
 * categories, or category-groups gets a warm in-memory hit after the first
 * call (10 min TTL, tag-invalidated on writes).
 *
 * Convention: cache keys use the `ref:` prefix.
 */

import type { components } from '../../generated/actual-client/types.js';
import { safeGetOrFetch } from './search/index.js';
import type { CacheTag } from './search/types.js';
import adapter from './actual-adapter.js';
import { budgetCacheKey } from './budgetContext.js';

type RefAccount = components['schemas']['Account'];
type RefPayee = components['schemas']['Payee'];
type RefCategory = components['schemas']['Category'];
type RefSchedule = { id?: string; name?: string };

const REF_TTL_MS = 10 * 60_000; // 10 minutes

export async function getCachedAccounts(): Promise<RefAccount[]> {
  return safeGetOrFetch(budgetCacheKey('ref:accounts'), {
    ttlMs: REF_TTL_MS,
    tags: ['accounts'] as CacheTag[],
    fetcher: () => adapter.getAccounts(),
  });
}

export async function getCachedPayees(): Promise<RefPayee[]> {
  return safeGetOrFetch(budgetCacheKey('ref:payees'), {
    ttlMs: REF_TTL_MS,
    tags: ['payees'] as CacheTag[],
    fetcher: () => adapter.getPayees(),
  });
}

export async function getCachedCategories(): Promise<RefCategory[]> {
  return safeGetOrFetch(budgetCacheKey('ref:categories'), {
    ttlMs: REF_TTL_MS,
    tags: ['categories'] as CacheTag[],
    fetcher: () => adapter.getCategories(),
  });
}

export async function getCachedCategoryGroups(): Promise<unknown[]> {
  return safeGetOrFetch(budgetCacheKey('ref:categoryGroups'), {
    ttlMs: REF_TTL_MS,
    tags: ['categories'] as CacheTag[],
    fetcher: () => adapter.getCategoryGroups(),
  });
}

export async function getCachedSchedules(): Promise<RefSchedule[]> {
  return safeGetOrFetch(budgetCacheKey('ref:schedules'), {
    ttlMs: REF_TTL_MS,
    tags: ['schedules'] as CacheTag[],
    fetcher: async () => {
      const schedules = await adapter.getSchedules();
      return Array.isArray(schedules) ? (schedules as RefSchedule[]) : [];
    },
  });
}

// ---------------------------------------------------------------------------
// Convenience map builders
// ---------------------------------------------------------------------------

export async function getAccountMap(): Promise<Map<string, string>> {
  const accounts = await getCachedAccounts();
  return new Map(accounts.filter((a) => a.id).map((a) => [a.id!, a.name ?? '']));
}

export async function getPayeeMap(): Promise<Map<string, string>> {
  const payees = await getCachedPayees();
  return new Map(payees.filter((p) => p.id).map((p) => [p.id!, p.name ?? '']));
}

export async function getCategoryMap(): Promise<Map<string, RefCategory>> {
  const categories = await getCachedCategories();
  return new Map(categories.filter((c) => c.id).map((c) => [c.id!, c]));
}

export async function getCategoryGroupMap(): Promise<Map<string, unknown>> {
  const groups = await getCachedCategoryGroups();
  return new Map((groups as any[]).map((g) => [g.id, g]));
}

export async function getScheduleMap(): Promise<Map<string, string>> {
  const schedules = await getCachedSchedules();
  return new Map(
    schedules
      .filter((s) => s.id)
      .map((s) => [s.id!, typeof s.name === 'string' ? s.name : ''])
  );
}
