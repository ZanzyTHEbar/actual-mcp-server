/**
 * Shared sync state for the search index.
 *
 * Lives in the search module (not the tool) to avoid circular imports
 * between CacheInvalidator → hybrid_search → config/adapter.
 */

let _synced = false;

/** Mark the search index as needing a re-sync on next query. */
export function markSearchIndexDirty(): void {
  _synced = false;
}

/** Check if the search index has been synced. */
export function isSearchIndexSynced(): boolean {
  return _synced;
}

/** Mark the search index as synced. */
export function markSearchIndexSynced(): void {
  _synced = true;
}
