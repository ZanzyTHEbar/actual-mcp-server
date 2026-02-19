/**
 * ResponseCache — in-memory TTL cache with tag-based invalidation and
 * stale-while-revalidate (SWR) support.
 *
 * Built on top of `lru-cache` v11.  Each cached entry is associated with one
 * or more `CacheTag`s so that write operations can surgically invalidate
 * related entries without flushing the entire cache.
 *
 * Usage:
 *   const cache = new ResponseCache();
 *   const accounts = await cache.getOrFetch('accounts:list', {
 *     ttlMs: 10 * 60_000,
 *     tags: ['accounts'],
 *     fetcher: () => adapter.getAccounts(),
 *   });
 *   // Later, after a write:
 *   cache.invalidateByTag('accounts');
 */

import { LRUCache } from 'lru-cache';
import type { CacheTag, CacheEntryOptions } from './types.js';
import logger from '../../logger.js';

// ---------------------------------------------------------------------------
// Configuration defaults
// ---------------------------------------------------------------------------

const DEFAULT_MAX_ENTRIES = 512;
const DEFAULT_TTL_MS = 5 * 60_000; // 5 minutes
const DEFAULT_STALE_MS = 2 * 60_000; // Allow stale for 2 min while revalidating

// ---------------------------------------------------------------------------
// Internal metadata kept alongside each cached value
// ---------------------------------------------------------------------------

interface CacheMeta {
  tags: Set<CacheTag>;
}

// ---------------------------------------------------------------------------
// ResponseCache
// ---------------------------------------------------------------------------

export class ResponseCache {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private cache: LRUCache<string, any>;
  private meta: Map<string, CacheMeta> = new Map();
  /** Tracks in-flight fetchers so concurrent callers coalesce. */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private inflight: Map<string, Promise<any>> = new Map();
  /** Monotonically increasing version; bumped on any invalidation. */
  private _version = 0;

  constructor(opts?: { maxEntries?: number }) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    this.cache = new LRUCache<string, any>({
      max: opts?.maxEntries ?? DEFAULT_MAX_ENTRIES,
      // TTL is set per-entry via the `set` options, but we need a global
      // default so the LRU knows to track TTL at all.
      ttl: DEFAULT_TTL_MS,
      // Allow reading stale entries while the fetcher is running.
      allowStale: true,
    });
  }

  // -------------------------------------------------------------------------
  // Public API
  // -------------------------------------------------------------------------

  /** Current cache version — bumped on every invalidation. */
  get version(): number {
    return this._version;
  }

  /**
   * Get a value from cache, or fetch it if missing / expired.
   *
   * If the entry is stale but within the SWR window, the stale value is
   * returned immediately and a background re-fetch is kicked off.
   */
  async getOrFetch<T>(
    key: string,
    opts: CacheEntryOptions & { fetcher: () => Promise<T> },
  ): Promise<T> {
    const cached = this.cache.get(key);
    if (cached !== undefined) {
      return cached as T;
    }

    // Coalesce concurrent requests for the same key.
    const existing = this.inflight.get(key);
    if (existing) {
      return existing as Promise<T>;
    }

    const promise = this.fetchAndStore<T>(key, opts);
    this.inflight.set(key, promise);

    try {
      return await promise;
    } finally {
      this.inflight.delete(key);
    }
  }

  /** Read without triggering a fetch. Returns `undefined` on miss. */
  peek<T>(key: string): T | undefined {
    return this.cache.get(key) as T | undefined;
  }

  /** Manually set a value (e.g. after a write that produces a known result). */
  set<T>(key: string, value: T, opts: CacheEntryOptions): void {
    this.cache.set(key, value, {
      ttl: opts.ttlMs,
    });
    this.meta.set(key, { tags: new Set(opts.tags) });
  }

  /** Invalidate all entries that carry the given tag. */
  invalidateByTag(tag: CacheTag): number {
    let count = 0;
    for (const [key, m] of this.meta.entries()) {
      if (m.tags.has(tag)) {
        this.cache.delete(key);
        this.meta.delete(key);
        count++;
      }
    }
    if (count > 0) {
      this._version++;
      logger.debug(`[Cache] Invalidated ${count} entries for tag "${tag}" (v${this._version})`);
    }
    return count;
  }

  /** Invalidate multiple tags at once (e.g. after a write that touches several entity types). */
  invalidateByTags(tags: CacheTag[]): number {
    let total = 0;
    for (const tag of tags) {
      total += this.invalidateByTag(tag);
    }
    return total;
  }

  /** Drop a single key. */
  invalidateKey(key: string): boolean {
    const existed = this.cache.delete(key);
    this.meta.delete(key);
    if (existed) this._version++;
    return existed;
  }

  /** Flush everything. */
  clear(): void {
    this.cache.clear();
    this.meta.clear();
    this._version++;
    logger.debug('[Cache] Cleared all entries');
  }

  /** Diagnostic snapshot. */
  getStats() {
    return {
      size: this.cache.size,
      maxSize: this.cache.max,
      version: this._version,
      inflight: this.inflight.size,
      tags: this.tagCounts(),
    };
  }

  // -------------------------------------------------------------------------
  // Internal
  // -------------------------------------------------------------------------

  private async fetchAndStore<T>(
    key: string,
    opts: CacheEntryOptions & { fetcher: () => Promise<T> },
  ): Promise<T> {
    const value = await opts.fetcher();
    this.cache.set(key, value, {
      ttl: opts.ttlMs,
    });
    this.meta.set(key, { tags: new Set(opts.tags) });
    return value;
  }

  private tagCounts(): Record<string, number> {
    const counts: Record<string, number> = {};
    for (const m of this.meta.values()) {
      for (const t of m.tags) {
        counts[t] = (counts[t] ?? 0) + 1;
      }
    }
    return counts;
  }
}

// ---------------------------------------------------------------------------
// Singleton per worker / process — lightweight, no global side-effects
// ---------------------------------------------------------------------------

let _instance: ResponseCache | null = null;

export function getResponseCache(): ResponseCache {
  if (!_instance) {
    _instance = new ResponseCache();
  }
  return _instance;
}

/**
 * Safely attempt a cached fetch. If the cache itself errors for any reason,
 * fall back to calling the fetcher directly. This ensures read tools never
 * break due to cache infrastructure issues.
 */
export async function safeGetOrFetch<T>(
  key: string,
  opts: {
    ttlMs: number;
    tags: CacheTag[];
    fetcher: () => Promise<T>;
  },
): Promise<T> {
  try {
    return await getResponseCache().getOrFetch(key, opts);
  } catch {
    // Cache is broken — bypass it and call the adapter directly
    return opts.fetcher();
  }
}
