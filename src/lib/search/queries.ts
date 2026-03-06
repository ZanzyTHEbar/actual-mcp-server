/**
 * Typed query layer for the search index.
 *
 * All SQL queries are centralized here with explicit input and output types.
 * This serves the same purpose as sqlc-generated code but works natively
 * with libsql's vector extensions, FTS5 virtual tables, and F32_BLOB types
 * that sqlc-gen-typescript cannot parse.
 *
 * Naming convention follows sqlc patterns:
 *   - getXxx: SELECT ... LIMIT 1 (returns T | undefined)
 *   - listXxx: SELECT ... (returns T[])
 *   - upsertXxx: INSERT ... ON CONFLICT DO UPDATE
 *   - deleteXxx: DELETE ...
 *   - countXxx: SELECT COUNT(*)
 */

import type { DatabaseInstance, CountRow, HashRow, SyncMetaRow, PragmaTableInfoRow } from './types.js';

// ---------------------------------------------------------------------------
// Reference data
// ---------------------------------------------------------------------------

export function upsertAccount(db: DatabaseInstance, id: string, name: string): void {
  db.prepare('INSERT OR REPLACE INTO accounts (id, name) VALUES (?, ?)').run(id, name);
}

export function upsertCategory(
  db: DatabaseInstance, id: string, name: string, groupId: string, groupName: string,
): void {
  db.prepare(
    'INSERT OR REPLACE INTO categories (id, name, group_id, group_name) VALUES (?, ?, ?, ?)',
  ).run(id, name, groupId, groupName);
}

export function upsertPayee(db: DatabaseInstance, id: string, name: string): void {
  db.prepare('INSERT OR REPLACE INTO payees (id, name) VALUES (?, ?)').run(id, name);
}

export function upsertCategoryGroup(db: DatabaseInstance, id: string, name: string): void {
  db.prepare('INSERT OR REPLACE INTO category_groups (id, name) VALUES (?, ?)').run(id, name);
}

// ---------------------------------------------------------------------------
// Content hash queries
// ---------------------------------------------------------------------------

export function listTransactionHashes(db: DatabaseInstance): HashRow[] {
  return db.prepare('SELECT id, content_hash FROM transactions').all() as HashRow[];
}

export function listTransactionIds(db: DatabaseInstance): { id: string }[] {
  return db.prepare('SELECT id FROM transactions').all() as { id: string }[];
}

// ---------------------------------------------------------------------------
// Sync metadata
// ---------------------------------------------------------------------------

export function getSyncTimestamp(db: DatabaseInstance): string | null {
  const row = db.prepare("SELECT value FROM sync_meta WHERE key = 'last_synced_at'").get() as SyncMetaRow | undefined;
  return row?.value ?? null;
}

export function setSyncTimestamp(db: DatabaseInstance, ts: string): void {
  db.prepare("INSERT OR REPLACE INTO sync_meta (key, value) VALUES ('last_synced_at', ?)").run(ts);
}

export function getSyncMetaValue(db: DatabaseInstance, key: string): string | null {
  const row = db.prepare('SELECT value FROM sync_meta WHERE key = ?').get(key) as SyncMetaRow | undefined;
  return row?.value ?? null;
}

export function setSyncMetaValue(db: DatabaseInstance, key: string, value: string): void {
  db.prepare('INSERT OR REPLACE INTO sync_meta (key, value) VALUES (?, ?)').run(key, value);
}

export function getSyncMetaInt(db: DatabaseInstance, key: string): number {
  const value = getSyncMetaValue(db, key);
  if (value === null) return 0;
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : 0;
}

export function setSyncMetaInt(db: DatabaseInstance, key: string, value: number): void {
  setSyncMetaValue(db, key, String(value));
}

export function incrementSyncMetaInt(db: DatabaseInstance, key: string): number {
  const next = getSyncMetaInt(db, key) + 1;
  setSyncMetaInt(db, key, next);
  return next;
}

// ---------------------------------------------------------------------------
// Embedding cache
// ---------------------------------------------------------------------------

interface EmbeddingCacheEntry {
  embedding: Buffer | Uint8Array | string;
}

export function getCachedEmbedding(db: DatabaseInstance, textHash: string): EmbeddingCacheEntry | undefined {
  return db.prepare('SELECT embedding FROM embedding_cache WHERE text_hash = ?').get(textHash) as EmbeddingCacheEntry | undefined;
}

export function setCachedEmbedding(db: DatabaseInstance, textHash: string, embedding: Buffer): void {
  db.prepare('INSERT OR REPLACE INTO embedding_cache (text_hash, embedding) VALUES (?, ?)').run(textHash, embedding);
}

// ---------------------------------------------------------------------------
// Counts
// ---------------------------------------------------------------------------

export function countTransactions(db: DatabaseInstance): number {
  return (db.prepare('SELECT COUNT(*) as c FROM transactions').get() as CountRow).c;
}

export function countAccounts(db: DatabaseInstance): number {
  return (db.prepare('SELECT COUNT(*) as c FROM accounts').get() as CountRow).c;
}

export function countCategories(db: DatabaseInstance): number {
  return (db.prepare('SELECT COUNT(*) as c FROM categories').get() as CountRow).c;
}

export function countPayees(db: DatabaseInstance): number {
  return (db.prepare('SELECT COUNT(*) as c FROM payees').get() as CountRow).c;
}

export function countEmbeddingCache(db: DatabaseInstance): number {
  return (db.prepare('SELECT COUNT(*) as c FROM embedding_cache').get() as CountRow).c;
}

// ---------------------------------------------------------------------------
// FTS maintenance
// ---------------------------------------------------------------------------

export function deleteFtsEntry(db: DatabaseInstance, txnId: string): void {
  db.prepare('DELETE FROM fts_transactions WHERE txn_id = ?').run(txnId);
}

export function insertFtsEntry(
  db: DatabaseInstance, txnId: string, payeeName: string,
  categoryName: string, accountName: string, notes: string,
): void {
  db.prepare(
    'INSERT INTO fts_transactions (txn_id, payee_name, category_name, account_name, notes) VALUES (?, ?, ?, ?, ?)',
  ).run(txnId, payeeName, categoryName, accountName, notes);
}

export function optimizeFts(db: DatabaseInstance): void {
  db.exec("INSERT INTO fts_transactions(fts_transactions) VALUES('optimize')");
}

// ---------------------------------------------------------------------------
// Transaction delete (for pruning)
// ---------------------------------------------------------------------------

export function deleteTransaction(db: DatabaseInstance, id: string): void {
  db.prepare('DELETE FROM transactions WHERE id = ?').run(id);
}

// ---------------------------------------------------------------------------
// Schema introspection
// ---------------------------------------------------------------------------

export function getTableInfo(db: DatabaseInstance, tableName: string): PragmaTableInfoRow[] {
  return db.prepare(`PRAGMA table_info(${tableName})`).all() as PragmaTableInfoRow[];
}
