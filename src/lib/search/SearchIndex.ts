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
import type {
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
  private db: InstanceType<typeof Database> | null = null;
  private dbPath: string;
  private _ready = false;
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
    this._ready = true;
    logger.info(`[SearchIndex] Opened at ${this.dbPath}`);
  }

  /** Close the database connection. */
  close(): void {
    if (!this.db) return;
    this.db.close();
    this.db = null;
    this._ready = false;
    logger.info('[SearchIndex] Closed');
  }

  get ready(): boolean {
    return this._ready;
  }

  /** Return the raw libsql Database handle (for HybridSearchEngine queries). */
  getDb(): InstanceType<typeof Database> {
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

      -- Embedding cache: dedup identical text → embedding mappings
      -- Text hash is MD5 of the input text; avoids re-embedding for
      -- repeated payee/category/notes combinations (~40% dedup rate).
      CREATE TABLE IF NOT EXISTS embedding_cache (
        text_hash  TEXT PRIMARY KEY,
        embedding  F32_BLOB(${EMBEDDING_DIMS}),
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
  }

  // -------------------------------------------------------------------------
  // Reference data population
  // -------------------------------------------------------------------------

  populateAccounts(accounts: RefAccount[]): void {
    const db = this.requireDb();
    const upsert = db.prepare(
      'INSERT OR REPLACE INTO accounts (id, name) VALUES (?, ?)',
    );
    const tx = db.transaction(() => {
      for (const a of accounts) {
        upsert.run(a.id, a.name ?? '');
      }
    });
    tx();
    logger.debug(`[SearchIndex] Populated ${accounts.length} accounts`);
  }

  populateCategories(categories: RefCategory[]): void {
    const db = this.requireDb();
    const upsert = db.prepare(
      'INSERT OR REPLACE INTO categories (id, name, group_id, group_name) VALUES (?, ?, ?, ?)',
    );
    const tx = db.transaction(() => {
      for (const c of categories) {
        upsert.run(c.id, c.name ?? '', c.group_id ?? '', c.group_name ?? '');
      }
    });
    tx();
    logger.debug(`[SearchIndex] Populated ${categories.length} categories`);
  }

  populatePayees(payees: RefPayee[]): void {
    const db = this.requireDb();
    const upsert = db.prepare(
      'INSERT OR REPLACE INTO payees (id, name) VALUES (?, ?)',
    );
    const tx = db.transaction(() => {
      for (const p of payees) {
        upsert.run(p.id, p.name ?? '');
      }
    });
    tx();
    logger.debug(`[SearchIndex] Populated ${payees.length} payees`);
  }

  populateCategoryGroups(groups: RefCategoryGroup[]): void {
    const db = this.requireDb();
    const upsert = db.prepare(
      'INSERT OR REPLACE INTO category_groups (id, name) VALUES (?, ?)',
    );
    const tx = db.transaction(() => {
      for (const g of groups) {
        upsert.run(g.id, g.name ?? '');
      }
    });
    tx();
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

    // ── Step 1: Load existing hashes for diff ─────────────────────────
    const existingHashes = new Map<string, string>();
    const hashRows = db.prepare('SELECT id, content_hash FROM transactions').all() as
      { id: string; content_hash: string }[];
    for (const r of hashRows) {
      existingHashes.set(r.id, r.content_hash);
    }

    // ── Step 2: Compute new hashes and filter to changed rows ─────────
    const changed: { tx: IndexedTransaction; hash: string }[] = [];
    for (const tx of transactions) {
      const h = SearchIndex.txHash(tx);
      const prev = existingHashes.get(tx.id);
      if (prev !== h) {
        changed.push({ tx, hash: h });
      }
    }

    if (changed.length === 0) {
      logger.info(
        `[SearchIndex] Incremental sync: 0/${transactions.length} changed — skipping re-index`,
      );
      // Still update sync timestamp
      db.prepare("INSERT OR REPLACE INTO sync_meta (key, value) VALUES ('last_synced_at', ?)")
        .run(new Date().toISOString());
      return 0;
    }

    logger.info(
      `[SearchIndex] Incremental sync: ${changed.length}/${transactions.length} changed — indexing`,
    );

    // ── Step 3: Prepare statements ────────────────────────────────────
    const upsertWithVec = db.prepare(`
      INSERT INTO transactions
        (id, date, amount, notes, payee_id, payee_name, category_id,
         category_name, account_id, account_name, is_transfer, cleared,
         content_hash, embedding)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, vector(?))
      ON CONFLICT(id) DO UPDATE SET
        date = excluded.date,
        amount = excluded.amount,
        notes = excluded.notes,
        payee_id = excluded.payee_id,
        payee_name = excluded.payee_name,
        category_id = excluded.category_id,
        category_name = excluded.category_name,
        account_id = excluded.account_id,
        account_name = excluded.account_name,
        is_transfer = excluded.is_transfer,
        cleared = excluded.cleared,
        content_hash = excluded.content_hash,
        embedding = excluded.embedding
    `);
    const upsertNoVec = db.prepare(`
      INSERT INTO transactions
        (id, date, amount, notes, payee_id, payee_name, category_id,
         category_name, account_id, account_name, is_transfer, cleared,
         content_hash)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        date = excluded.date,
        amount = excluded.amount,
        notes = excluded.notes,
        payee_id = excluded.payee_id,
        payee_name = excluded.payee_name,
        category_id = excluded.category_id,
        category_name = excluded.category_name,
        account_id = excluded.account_id,
        account_name = excluded.account_name,
        is_transfer = excluded.is_transfer,
        cleared = excluded.cleared,
        content_hash = excluded.content_hash
    `);

    const ftsDelete = db.prepare(
      'DELETE FROM fts_transactions WHERE txn_id = ?',
    );
    const ftsInsert = db.prepare(`
      INSERT INTO fts_transactions (txn_id, payee_name, category_name, account_name, notes)
      VALUES (?, ?, ?, ?, ?)
    `);

    // ── Step 4: Prepare embedding cache lookups ─────────────────────
    const getCachedEmb = db.prepare(
      'SELECT embedding FROM embedding_cache WHERE text_hash = ?',
    );
    const setCachedEmb = db.prepare(
      'INSERT OR REPLACE INTO embedding_cache (text_hash, embedding) VALUES (?, vector(?))',
    );

    let indexed = 0;
    let cacheHits = 0;
    let cacheMisses = 0;
    const BATCH_SIZE = 100;

    for (let i = 0; i < changed.length; i += BATCH_SIZE) {
      const batch = changed.slice(i, i + BATCH_SIZE);

      // Generate embeddings — check cache first, call provider on miss
      const embeddings: (number[] | null)[] = [];
      for (const { tx } of batch) {
        const text = this.emb.buildTransactionText(tx);
        const textHash = crypto.createHash('md5').update(text).digest('hex');

        // Cache lookup
        const cached = getCachedEmb.get(textHash) as { embedding: any } | undefined;
        if (cached?.embedding) {
          embeddings.push(cached.embedding);
          cacheHits++;
        } else {
          const vec = await this.emb.embed(text);
          embeddings.push(vec);
          cacheMisses++;
          // Store in cache for future reuse
          if (vec) {
            try {
              setCachedEmb.run(textHash, JSON.stringify(vec));
            } catch {
              // Non-fatal — cache write failure doesn't block indexing
            }
          }
        }
      }

      const writeBatch = db.transaction(() => {
        for (let j = 0; j < batch.length; j++) {
          const { tx, hash } = batch[j];
          const baseArgs = [
            tx.id,
            tx.date,
            tx.amount,
            tx.notes,
            tx.payee_id,
            tx.payee_name,
            tx.category_id,
            tx.category_name,
            tx.account_id,
            tx.account_name,
            tx.is_transfer ? 1 : 0,
            tx.cleared ? 1 : 0,
            hash,
          ] as const;

          if (embeddings[j]) {
            upsertWithVec.run(...baseArgs, JSON.stringify(embeddings[j]));
          } else {
            upsertNoVec.run(...baseArgs);
          }

          // Sync FTS5
          ftsDelete.run(tx.id);
          ftsInsert.run(tx.id, tx.payee_name, tx.category_name, tx.account_name, tx.notes);
        }
      });
      writeBatch();
      indexed += batch.length;

      if (indexed % 500 === 0) {
        logger.debug(`[SearchIndex] Indexed ${indexed}/${changed.length} changed transactions…`);
      }
    }

    // Optimize FTS5
    db.exec("INSERT INTO fts_transactions(fts_transactions) VALUES('optimize')");

    // Record sync time
    db.prepare("INSERT OR REPLACE INTO sync_meta (key, value) VALUES ('last_synced_at', ?)")
      .run(new Date().toISOString());

    const elapsed = Date.now() - startMs;
    const hitRate = cacheHits + cacheMisses > 0
      ? Math.round((cacheHits / (cacheHits + cacheMisses)) * 100)
      : 0;
    logger.info(
      `[SearchIndex] Indexed ${indexed} changed transactions in ${elapsed}ms ` +
      `(embedding cache: ${cacheHits} hits, ${cacheMisses} misses, ${hitRate}% hit rate)`,
    );

    return indexed;
  }

  /**
   * Remove transactions that no longer exist in Actual Budget.
   * Pass the set of current IDs; anything not in the set is deleted.
   */
  pruneStale(currentIds: Set<string>): number {
    const db = this.requireDb();
    const allRows = db.prepare('SELECT id FROM transactions').all() as { id: string }[];
    const toDelete = allRows.filter((r) => !currentIds.has(r.id)).map((r) => r.id);

    if (toDelete.length === 0) return 0;

    const del = db.prepare('DELETE FROM transactions WHERE id = ?');
    const ftsDel = db.prepare('DELETE FROM fts_transactions WHERE txn_id = ?');
    const tx = db.transaction(() => {
      for (const id of toDelete) {
        ftsDel.run(id);
        del.run(id);
      }
    });
    tx();

    logger.info(`[SearchIndex] Pruned ${toDelete.length} stale transactions`);
    return toDelete.length;
  }

  // -------------------------------------------------------------------------
  // Stats
  // -------------------------------------------------------------------------

  getStats(): SearchIndexStats {
    const db = this.requireDb();
    const txnCount = (db.prepare('SELECT COUNT(*) as c FROM transactions').get() as { c: number }).c;
    const accCount = (db.prepare('SELECT COUNT(*) as c FROM accounts').get() as { c: number }).c;
    const catCount = (db.prepare('SELECT COUNT(*) as c FROM categories').get() as { c: number }).c;
    const payCount = (db.prepare('SELECT COUNT(*) as c FROM payees').get() as { c: number }).c;

    let sizeBytes = 0;
    try {
      const stat = fs.statSync(this.dbPath);
      sizeBytes = stat.size;
    } catch {
      // file may not exist yet
    }

    const lastSynced = db.prepare("SELECT value FROM sync_meta WHERE key = 'last_synced_at'").get() as
      | { value: string }
      | undefined;

    const modelInfo = this.emb.getModelInfo();

    // Embedding cache stats
    let embeddingCacheSize = 0;
    try {
      embeddingCacheSize = (db.prepare('SELECT COUNT(*) as c FROM embedding_cache').get() as { c: number }).c;
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
      lastSyncedAt: lastSynced?.value ?? null,
      embeddingModel: modelInfo.model,
      embeddingDimensions: modelInfo.dimensions,
    };
  }

  // -------------------------------------------------------------------------
  // Helpers
  // -------------------------------------------------------------------------

  private requireDb(): InstanceType<typeof Database> {
    if (!this.db) throw new Error('SearchIndex not opened — call open() first');
    return this.db;
  }
}
