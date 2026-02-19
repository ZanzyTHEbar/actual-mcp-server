/**
 * Unit tests for SearchIndex
 *
 * Tests: schema creation, populate reference data, indexTransactions
 * (with mock embeddings), pruneStale, getStats, upsert.
 *
 * Uses injectable embedding functions to avoid downloading the HF model.
 */
console.log('Running SearchIndex unit tests');

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

(async () => {
  const { SearchIndex } = await import('../../dist/src/lib/search/SearchIndex.js');
  const { buildTransactionText } = await import('../../dist/src/lib/search/EmbeddingPipeline.js');

  let embedCallCount = 0;
  const mockEmbedding = {
    embed: async (text) => {
      embedCallCount++;
      const vec = new Array(384).fill(0);
      for (let i = 0; i < Math.min(text.length, 384); i++) {
        vec[i] = (text.charCodeAt(i) % 100) / 100;
      }
      return vec;
    },
    buildTransactionText,
    getModelInfo: () => ({
      model: 'mock-model',
      dimensions: 384,
      loaded: true,
    }),
  };

  // ---------------------------------------------------------------------------
  // Test 1: Open creates schema (isolated DB)
  // ---------------------------------------------------------------------------
  {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'si-test1-'));
    try {
      const index = new SearchIndex(tmpDir, mockEmbedding);
      index.open();
      assert.equal(index.ready, true, 'Index should be ready after open');

      const db = index.getDb();
      const tables = db
        .prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
        .all()
        .map((r) => r.name);

      assert.ok(tables.includes('accounts'), 'accounts table should exist');
      assert.ok(tables.includes('categories'), 'categories table should exist');
      assert.ok(tables.includes('payees'), 'payees table should exist');
      assert.ok(tables.includes('transactions'), 'transactions table should exist');
      assert.ok(tables.includes('sync_meta'), 'sync_meta table should exist');

      index.close();
      assert.equal(index.ready, false);
      console.log('  ✓ Open creates schema, close resets ready');
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  }

  // ---------------------------------------------------------------------------
  // Test 2: Populate reference data with upsert (isolated DB)
  // ---------------------------------------------------------------------------
  {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'si-test2-'));
    try {
      const index = new SearchIndex(tmpDir, mockEmbedding);
      index.open();

      index.populateAccounts([
        { id: 'acc-1', name: 'Checking' },
        { id: 'acc-2', name: 'Savings' },
      ]);
      index.populateCategories([
        { id: 'cat-1', name: 'Groceries', group_id: 'grp-1', group_name: 'Food' },
        { id: 'cat-2', name: 'Rent', group_id: 'grp-2', group_name: 'Housing' },
      ]);
      index.populatePayees([
        { id: 'pay-1', name: 'Whole Foods' },
        { id: 'pay-2', name: 'Landlord' },
      ]);

      const db = index.getDb();
      const accCount = db.prepare('SELECT COUNT(*) as c FROM accounts').get().c;
      const catCount = db.prepare('SELECT COUNT(*) as c FROM categories').get().c;
      const payCount = db.prepare('SELECT COUNT(*) as c FROM payees').get().c;

      assert.equal(accCount, 2, 'Should have 2 accounts');
      assert.equal(catCount, 2, 'Should have 2 categories');
      assert.equal(payCount, 2, 'Should have 2 payees');

      // Test upsert
      index.populateAccounts([{ id: 'acc-1', name: 'Main Checking' }]);
      const updated = db.prepare('SELECT name FROM accounts WHERE id = ?').get('acc-1');
      assert.equal(updated.name, 'Main Checking', 'Upsert should update name');

      index.close();
      console.log('  ✓ Populate reference data with upsert');
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  }

  // ---------------------------------------------------------------------------
  // Tests 3-6: Sequential tests (index, prune, stats, upsert) on a single DB
  // ---------------------------------------------------------------------------
  {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'si-test3-'));
    const index = new SearchIndex(tmpDir, mockEmbedding);

    try {
      index.open();

      // Populate refs first
      index.populateAccounts([
        { id: 'acc-1', name: 'Checking' },
        { id: 'acc-2', name: 'Savings' },
      ]);
      index.populateCategories([
        { id: 'cat-1', name: 'Groceries' },
        { id: 'cat-2', name: 'Rent' },
        { id: 'cat-3', name: 'Salary' },
      ]);
      index.populatePayees([
        { id: 'pay-1', name: 'Whole Foods' },
        { id: 'pay-2', name: 'Landlord' },
      ]);

      // --- Test 3: indexTransactions ---
      embedCallCount = 0;

      const transactions = [
        {
          id: 'txn-1', date: '2026-01-15', amount: -8523,
          notes: 'Weekly grocery run', payee_id: 'pay-1', payee_name: 'Whole Foods',
          category_id: 'cat-1', category_name: 'Groceries',
          account_id: 'acc-1', account_name: 'Checking',
          is_transfer: false, cleared: true,
        },
        {
          id: 'txn-2', date: '2026-02-01', amount: -120000,
          notes: 'February rent', payee_id: 'pay-2', payee_name: 'Landlord',
          category_id: 'cat-2', category_name: 'Rent',
          account_id: 'acc-1', account_name: 'Checking',
          is_transfer: false, cleared: true,
        },
        {
          id: 'txn-3', date: '2026-02-01', amount: 500000,
          notes: 'Paycheck', payee_id: 'pay-3', payee_name: 'Employer',
          category_id: 'cat-3', category_name: 'Salary',
          account_id: 'acc-1', account_name: 'Checking',
          is_transfer: false, cleared: false,
        },
      ];

      const indexed = await index.indexTransactions(transactions);
      assert.equal(indexed, 3, 'Should index 3 transactions');
      assert.equal(embedCallCount, 3, 'Should call embed once per transaction');

      const db = index.getDb();
      const count = db.prepare('SELECT COUNT(*) as c FROM transactions').get().c;
      assert.equal(count, 3);

      const txn1 = db.prepare('SELECT * FROM transactions WHERE id = ?').get('txn-1');
      assert.equal(txn1.payee_name, 'Whole Foods');
      assert.equal(txn1.amount, -8523);
      assert.equal(txn1.cleared, 1);

      // Verify FTS5
      const ftsResults = db
        .prepare("SELECT rowid FROM fts_transactions WHERE fts_transactions MATCH 'grocery'")
        .all();
      assert.ok(ftsResults.length >= 1, 'FTS5 should find grocery');

      // Verify sync_meta
      const syncMeta = db
        .prepare("SELECT value FROM sync_meta WHERE key = 'last_synced_at'")
        .get();
      assert.ok(syncMeta && syncMeta.value, 'last_synced_at should be set');

      console.log('  ✓ Index transactions with mock embeddings');

      // --- Test 4: pruneStale ---
      const currentIds = new Set(['txn-1', 'txn-3']);
      const pruned = index.pruneStale(currentIds);
      assert.equal(pruned, 1, 'Should prune 1 stale transaction');

      const remaining = db.prepare('SELECT id FROM transactions ORDER BY id').all().map((r) => r.id);
      assert.deepEqual(remaining, ['txn-1', 'txn-3']);
      console.log('  ✓ pruneStale removes deleted transactions');

      // --- Test 5: getStats ---
      const stats = index.getStats();
      assert.equal(stats.totalTransactions, 2, 'Should have 2 transactions after prune');
      assert.equal(stats.totalAccounts, 2);
      assert.equal(stats.totalCategories, 3);
      assert.equal(stats.totalPayees, 2);
      assert.ok(stats.indexSizeBytes > 0, 'Index should have nonzero size');
      assert.ok(stats.lastSyncedAt, 'lastSyncedAt should be set');
      assert.equal(stats.embeddingModel, 'mock-model');
      assert.equal(stats.embeddingDimensions, 384);
      console.log('  ✓ getStats returns correct values');

      // --- Test 6: Re-indexing (upsert) ---
      await index.indexTransactions([
        {
          id: 'txn-1', date: '2026-01-15', amount: -9000,
          notes: 'Updated notes', payee_id: 'pay-1', payee_name: 'Whole Foods',
          category_id: 'cat-1', category_name: 'Groceries',
          account_id: 'acc-1', account_name: 'Checking',
          is_transfer: false, cleared: true,
        },
      ]);

      const txnUpdated = db.prepare('SELECT * FROM transactions WHERE id = ?').get('txn-1');
      assert.equal(txnUpdated.amount, -9000, 'Amount should be updated');
      assert.equal(txnUpdated.notes, 'Updated notes', 'Notes should be updated');

      const totalCount = db.prepare('SELECT COUNT(*) as c FROM transactions').get().c;
      assert.equal(totalCount, 2, 'Upsert should not duplicate');
      console.log('  ✓ Re-indexing upserts without duplicating');

    } finally {
      index.close();
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  }

  console.log('All SearchIndex tests passed ✓');
})().catch((err) => {
  console.error('SearchIndex test failed:', err?.message ?? err, err?.stack ?? '');
  process.exit(1);
});
