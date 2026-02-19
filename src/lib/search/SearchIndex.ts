/**
 * SearchIndex — libsql-backed search index with FTS5, vector columns, and
 * relational metadata.  Manages schema creation, data population from the
 * Actual Budget adapter, and incremental updates.
 *
 * The index DB is stored as a file alongside the Actual data directory so it
 * persists across restarts but can be safely rebuilt at any time.
 */

import Database from 'libsql';
import path from 'path';
import fs from 'fs';
import crypto from 'crypto';
import logger from '../../logger.js';
import { embed as defaultEmbed, buildTransactionText as defaultBuildText, getModelInfo as defaultModelInfo } from './EmbeddingPipeline.js';
import { embeddingToF32Blob, f32BlobToEmbedding, embeddingToVectorString } from './embedding-codec.js';
import { detectCapabilities, type DbCapabilities } from './capabilities.js';
import * as Q from './queries.js';
import type {
  DatabaseInstance,
  IndexedTransaction,
  RefAccount,
  RefCategory,
  RefPayee,
  RefCategoryGroup,
  SearchIndexStats,
} from './types.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const INDEX_DB_NAME = 'search-index.db';
const EMBEDDING_DIMS = 384; // all-MiniLM-L6-v2

// ---------------------------------------------------------------------------
// Injectable embedding functions (for testing)
// ---------------------------------------------------------------------------

export interface EmbeddingFunctions {
  embed: (text: string) => Promise<number[] | null>;
  buildTransactionText: (tx: {
    payee_name: string; category_name: string; account_name: string;
    notes: string; amount: number; date: string;
  }) => string;
  getModelInfo: () => { model: string; dimensions: number; loaded: boolean };
}

const defaultEmbedding: EmbeddingFunctions = {
  embed: defaultEmbed,
  buildTransactionText: defaultBuildText,
  getModelInfo: defaultModelInfo,
};

// ---------------------------------------------------------------------------
// SearchIndex
// ---------------------------------------------------------------------------

export class SearchIndex {
  private db: DatabaseInstance | null = null;
  private dbPath: string;
  private _ready = false;
  private _caps: DbCapabilities | null = null;
  private emb: EmbeddingFunctions;

  constructor(dataDir: string, embeddingFns?: EmbeddingFunctions) {
    if (!fs.existsSync(dataDir)) {
      fs.mkdirSync(dataDir, { recursive: true });
    }
    this.dbPath = path.join(dataDir, INDEX_DB_NAME);
    this.emb = embeddingFns ?? defaultEmbedding;
  }

  // -------------------------------------------------------------------------
  // Lifecycle
  // -------------------------------------------------------------------------

  /** Open (or create) the index database and ensure schema is up to date. */
  open(): void {
    if (this.db) return;

    this.db = new Database(this.dbPath);
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('synchronous = NORMAL');
    this.db.pragma('foreign_keys = ON');

    this.ensureSchema();
    this.runMigrations();
    this._caps = detectCapabilities(this.db);
    this._ready = true;
    logger.info(`[SearchIndex] Opened at ${this.dbPath}`);
  }

  /** Close the database connection. */
  close(): void {
    if (!this.db) return;
    this.db.close();
    this.db = null;
    this._ready = false;
    this._caps = null;
    logger.info('[SearchIndex] Closed');
  }

  get ready(): boolean {
    return this._ready;
  }

  get capabilities(): DbCapabilities | null {
    return this._caps;
  }

  /** Return the raw libsql Database handle (for HybridSearchEngine queries). */
  getDb(): DatabaseInstance {
    if (!this.db) throw new Error('SearchIndex not opened');
    return this.db;
  }

  // -------------------------------------------------------------------------
  // Schema
  // -------------------------------------------------------------------------

  private ensureSchema(): void {
    const db = this.requireDb();

    db.exec(`
      -- Reference tables
      CREATE TABLE IF NOT EXISTS accounts (
        id   TEXT PRIMARY KEY,
        name TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS categories (
        id         TEXT PRIMARY KEY,
        name       TEXT NOT NULL,
        group_id   TEXT,
        group_name TEXT
      );

      CREATE TABLE IF NOT EXISTS payees (
        id   TEXT PRIMARY KEY,
        name TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS category_groups (
        id   TEXT PRIMARY KEY,
        name TEXT NOT NULL
      );

      -- Main transaction table with native vector column
      CREATE TABLE IF NOT EXISTS transactions (
        id            TEXT PRIMARY KEY,
        date          TEXT NOT NULL,
        amount        INTEGER NOT NULL DEFAULT 0,
        notes         TEXT NOT NULL DEFAULT '',
        payee_id      TEXT NOT NULL DEFAULT '',
        payee_name    TEXT NOT NULL DEFAULT '',
        category_id   TEXT NOT NULL DEFAULT '',
        category_name TEXT NOT NULL DEFAULT '',
        account_id    TEXT NOT NULL DEFAULT '',
        account_name  TEXT NOT NULL DEFAULT '',
        is_transfer   INTEGER NOT NULL DEFAULT 0,
        cleared       INTEGER NOT NULL DEFAULT 0,
        -- Per-row content hash for incremental sync (skip unchanged rows)
        content_hash  TEXT NOT NULL DEFAULT '',
        -- Native F32 vector column for semantic search
        embedding     F32_BLOB(${EMBEDDING_DIMS})
      );

      -- NOTE: DiskANN vector index omitted — at our scale (<10k rows) brute-force
      -- vector_distance_cos() is fast enough and avoids a known libsql
      -- incompatibility between DiskANN and FTS5 external content tables.
      -- Add DiskANN index when scale exceeds ~10k vectors.

      -- Self-contained FTS5 index (libsql does not support external content tables)
      -- We store txn_id as an explicit column for joins back to transactions.
      CREATE VIRTUAL TABLE IF NOT EXISTS fts_transactions USING fts5(
        txn_id,
        payee_name,
        category_name,
        account_name,
        notes
      );

      -- Metadata indexes for fast filtering
      CREATE INDEX IF NOT EXISTS idx_txn_date       ON transactions(date);
      CREATE INDEX IF NOT EXISTS idx_txn_account    ON transactions(account_id);
      CREATE INDEX IF NOT EXISTS idx_txn_category   ON transactions(category_id);
      CREATE INDEX IF NOT EXISTS idx_txn_payee      ON transactions(payee_id);
      CREATE INDEX IF NOT EXISTS idx_txn_amount     ON transactions(amount);

      -- Sync metadata
      CREATE TABLE IF NOT EXISTS sync_meta (
        key   TEXT PRIMARY KEY,
        value TEXT
      );

      -- Embedding cache: dedup identical text → embedding mappings.
      -- Text hash is MD5 of the input text; avoids re-embedding for
      -- repeated payee/category/notes combinations (~40% dedup rate).
      -- Stored as BLOB (F32_BLOB wire format: LE float32, 4B/element).
      CREATE TABLE IF NOT EXISTS embedding_cache (
        text_hash  TEXT PRIMARY KEY,
        embedding  BLOB NOT NULL,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
    `);

    logger.debug('[SearchIndex] Schema ensured');
  }

  /** Lightweight forward-only migrations for schema additions. */
  private runMigrations(): void {
    const db = this.requireDb();
    // Migration 1: add content_hash column (v0 → v1)
    try {
      db.exec('ALTER TABLE transactions ADD COLUMN content_hash TEXT NOT NULL DEFAULT ""');
      logger.info('[SearchIndex] Migration: added content_hash column');
    } catch {
      // Column already exists — ignore
    }

    // Migration 2: rebuild embedding_cache as BLOB if currently TEXT
    // (earlier version used TEXT/JSON as a workaround; now properly using F32_BLOB binary)
    try {
      const info = Q.getTableInfo(db, 'embedding_cache');
      const embCol = info.find((c) => c.name === 'embedding');
      if (embCol && embCol.type === 'TEXT') {
        db.exec('DROP TABLE embedding_cache');
        db.exec(`CREATE TABLE embedding_cache (
          text_hash  TEXT PRIMARY KEY,
          embedding  BLOB NOT NULL,
          created_at TEXT NOT NULL DEFAULT (datetime('now'))
        )`);
        logger.info('[SearchIndex] Migration: rebuilt embedding_cache with BLOB column (F32_BLOB binary)');
      }
    } catch {
      // Table may not exist yet — schema creation will handle it
    }
  }

  // -------------------------------------------------------------------------
  // Reference data population
  // -------------------------------------------------------------------------

  populateAccounts(accounts: RefAccount[]): void {
    const db = this.requireDb();
    db.transaction(() => { for (const a of accounts) Q.upsertAccount(db, a.id, a.name ?? ''); })();
    logger.debug(`[SearchIndex] Populated ${accounts.length} accounts`);
  }

  populateCategories(categories: RefCategory[]): void {
    const db = this.requireDb();
    db.transaction(() => { for (const c of categories) Q.upsertCategory(db, c.id, c.name ?? '', c.group_id ?? '', c.group_name ?? ''); })();
    logger.debug(`[SearchIndex] Populated ${categories.length} categories`);
  }

  populatePayees(payees: RefPayee[]): void {
    const db = this.requireDb();
    db.transaction(() => { for (const p of payees) Q.upsertPayee(db, p.id, p.name ?? ''); })();
    logger.debug(`[SearchIndex] Populated ${payees.length} payees`);
  }

  populateCategoryGroups(groups: RefCategoryGroup[]): void {
    const db = this.requireDb();
    db.transaction(() => { for (const g of groups) Q.upsertCategoryGroup(db, g.id, g.name ?? ''); })();
    logger.debug(`[SearchIndex] Populated ${groups.length} category groups`);
  }

  // -------------------------------------------------------------------------
  // Content hashing (for incremental sync)
  // -------------------------------------------------------------------------

  /**
   * Compute a fast content fingerprint for a transaction.
   * If any field changes, the hash changes → triggers re-indexing.
   */
  private static txHash(tx: IndexedTransaction): string {
    const raw = `${tx.id}|${tx.date}|${tx.amount}|${tx.notes}|${tx.payee_id}|${tx.payee_name}|${tx.category_id}|${tx.category_name}|${tx.account_id}|${tx.account_name}|${tx.is_transfer}|${tx.cleared}`;
    return crypto.createHash('md5').update(raw).digest('hex');
  }

  // -------------------------------------------------------------------------
  // Transaction indexing
  // -------------------------------------------------------------------------

  /**
   * Index a batch of transactions with incremental sync.
   *
   * Compares content hashes against existing rows to skip unchanged
   * transactions.  Only new or modified rows get re-embedded and written.
   *
   * Returns the number of rows actually written (not the total input count).
   */
  async indexTransactions(transactions: IndexedTransaction[]): Promise<number> {
    const db = this.requireDb();
    const startMs = Date.now();

    const changed = this.diffTransactions(db, transactions);
    if (changed.length === 0) {
      logger.info(`[SearchIndex] Incremental sync: 0/${transactions.length} changed — skipping re-index`);
      this.recordSyncTimestamp(db);
      return 0;
    }

    logger.info(`[SearchIndex] Incremental sync: ${changed.length}/${transactions.length} changed — indexing`);

    const stats = await this.indexChangedBatches(db, changed);
    Q.optimizeFts(db);
    this.recordSyncTimestamp(db);

    const elapsed = Date.now() - startMs;
    const hitRate = stats.cacheHits + stats.cacheMisses > 0
      ? Math.round((stats.cacheHits / (stats.cacheHits + stats.cacheMisses)) * 100)
      : 0;
    logger.info(
      `[SearchIndex] Indexed ${stats.indexed} changed transactions in ${elapsed}ms ` +
      `(embedding cache: ${stats.cacheHits} hits, ${stats.cacheMisses} misses, ${hitRate}% hit rate)`,
    );

    return stats.indexed;
  }

  private diffTransactions(
    db: DatabaseInstance,
    transactions: IndexedTransaction[],
  ): { tx: IndexedTransaction; hash: string }[] {
    const existingHashes = new Map<string, string>();
    for (const r of Q.listTransactionHashes(db)) existingHashes.set(r.id, r.content_hash);

    const changed: { tx: IndexedTransaction; hash: string }[] = [];
    for (const tx of transactions) {
      const h = SearchIndex.txHash(tx);
      if (existingHashes.get(tx.id) !== h) changed.push({ tx, hash: h });
    }
    return changed;
  }

  private async resolveEmbedding(
    db: DatabaseInstance,
    text: string,
  ): Promise<{ vec: number[] | null; hit: boolean }> {
    const textHash = crypto.createHash('md5').update(text).digest('hex');
    const cached = Q.getCachedEmbedding(db, textHash);

    if (cached?.embedding) {
      try {
        if (typeof cached.embedding === 'string') {
          return { vec: JSON.parse(cached.embedding) as number[], hit: true };
        }
        const vec = f32BlobToEmbedding(cached.embedding as Buffer | Uint8Array);
        if (vec) return { vec, hit: true };
      } catch {
        // Corrupted cache entry — treat as miss
      }
    }

    const vec = await this.emb.embed(text);
    if (vec) {
      const blob = embeddingToF32Blob(vec);
      if (blob) {
        try { Q.setCachedEmbedding(db, textHash, blob); } catch { /* non-fatal */ }
      }
    }
    return { vec, hit: false };
  }

  private async indexChangedBatches(
    db: DatabaseInstance,
    changed: { tx: IndexedTransaction; hash: string }[],
  ): Promise<{ indexed: number; cacheHits: number; cacheMisses: number }> {
    const upsertWithVec = db.prepare(`
      INSERT INTO transactions
        (id, date, amount, notes, payee_id, payee_name, category_id,
         category_name, account_id, account_name, is_transfer, cleared,
         content_hash, embedding)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, vector32(?))
      ON CONFLICT(id) DO UPDATE SET
        date=excluded.date, amount=excluded.amount, notes=excluded.notes,
        payee_id=excluded.payee_id, payee_name=excluded.payee_name,
        category_id=excluded.category_id, category_name=excluded.category_name,
        account_id=excluded.account_id, account_name=excluded.account_name,
        is_transfer=excluded.is_transfer, cleared=excluded.cleared,
        content_hash=excluded.content_hash, embedding=excluded.embedding
    `);
    const upsertNoVec = db.prepare(`
      INSERT INTO transactions
        (id, date, amount, notes, payee_id, payee_name, category_id,
         category_name, account_id, account_name, is_transfer, cleared,
         content_hash, embedding)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)
      ON CONFLICT(id) DO UPDATE SET
        date=excluded.date, amount=excluded.amount, notes=excluded.notes,
        payee_id=excluded.payee_id, payee_name=excluded.payee_name,
        category_id=excluded.category_id, category_name=excluded.category_name,
        account_id=excluded.account_id, account_name=excluded.account_name,
        is_transfer=excluded.is_transfer, cleared=excluded.cleared,
        content_hash=excluded.content_hash, embedding=NULL
    `);
    let indexed = 0;
    let cacheHits = 0;
    let cacheMisses = 0;
    const BATCH_SIZE = 100;

    for (let i = 0; i < changed.length; i += BATCH_SIZE) {
      const batch = changed.slice(i, i + BATCH_SIZE);

      const embeddings: (number[] | null)[] = [];
      for (const { tx } of batch) {
        const text = this.emb.buildTransactionText(tx);
        const { vec, hit } = await this.resolveEmbedding(db, text);
        embeddings.push(vec);
        if (hit) cacheHits++; else cacheMisses++;
      }

      db.transaction(() => {
        for (let j = 0; j < batch.length; j++) {
          const { tx, hash } = batch[j];
          const base = [
            tx.id, tx.date, tx.amount, tx.notes,
            tx.payee_id, tx.payee_name, tx.category_id, tx.category_name,
            tx.account_id, tx.account_name, tx.is_transfer ? 1 : 0, tx.cleared ? 1 : 0, hash,
          ] as const;

          if (embeddings[j]) {
            upsertWithVec.run(...base, embeddingToVectorString(embeddings[j]!));
          } else {
            upsertNoVec.run(...base);
          }

          Q.deleteFtsEntry(db, tx.id);
          Q.insertFtsEntry(db, tx.id, tx.payee_name, tx.category_name, tx.account_name, tx.notes);
        }
      })();
      indexed += batch.length;

      if (indexed % 500 === 0) {
        logger.debug(`[SearchIndex] Indexed ${indexed}/${changed.length} changed transactions…`);
      }
    }

    return { indexed, cacheHits, cacheMisses };
  }

  private recordSyncTimestamp(db: DatabaseInstance): void {
    Q.setSyncTimestamp(db, new Date().toISOString());
  }

  /**
   * Remove transactions that no longer exist in Actual Budget.
   * Pass the set of current IDs; anything not in the set is deleted.
   */
  pruneStale(currentIds: Set<string>): number {
    const db = this.requireDb();
    const allRows = Q.listTransactionIds(db);
    const toDelete = allRows.filter((r) => !currentIds.has(r.id)).map((r) => r.id);

    if (toDelete.length === 0) return 0;

    db.transaction(() => {
      for (const id of toDelete) {
        Q.deleteFtsEntry(db, id);
        Q.deleteTransaction(db, id);
      }
    })();

    logger.info(`[SearchIndex] Pruned ${toDelete.length} stale transactions`);
    return toDelete.length;
  }

  // -------------------------------------------------------------------------
  // Stats
  // -------------------------------------------------------------------------

  getStats(): SearchIndexStats {
    const db = this.requireDb();
    const txnCount = Q.countTransactions(db);
    const accCount = Q.countAccounts(db);
    const catCount = Q.countCategories(db);
    const payCount = Q.countPayees(db);

    let sizeBytes = 0;
    try {
      const stat = fs.statSync(this.dbPath);
      sizeBytes = stat.size;
    } catch {
      // file may not exist yet
    }

    const lastSyncedTs = Q.getSyncTimestamp(db);

    const modelInfo = this.emb.getModelInfo();

    let embeddingCacheSize = 0;
    try {
      embeddingCacheSize = Q.countEmbeddingCache(db);
    } catch {
      // Table may not exist on old schema
    }

    return {
      totalTransactions: txnCount,
      totalAccounts: accCount,
      totalCategories: catCount,
      totalPayees: payCount,
      embeddingCacheEntries: embeddingCacheSize,
      indexSizeBytes: sizeBytes,
      lastSyncedAt: lastSyncedTs,
      embeddingModel: modelInfo.model,
      embeddingDimensions: modelInfo.dimensions,
    };
  }

  // -------------------------------------------------------------------------
  // Helpers
  // -------------------------------------------------------------------------

  private requireDb(): DatabaseInstance {
    if (!this.db) throw new Error('SearchIndex not opened — call open() first');
    return this.db;
  }
}
