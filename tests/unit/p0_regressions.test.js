/**
 * Phase 0 — P0 regression tests.
 *
 * These tests reproduce the three confirmed P0 defects:
 *   1. Embedding cache returns F32_BLOB binary instead of number[]
 *      → corrupted vectors on cache-hit re-index.
 *   2. sanitizeFtsQuery destroys expandQuery output
 *      → query expansion is effectively dead.
 *   3. queryAnalyzer extractedAmounts / extractedDateHints are never
 *      wired into effective search filters.
 *
 * Each test is written so it FAILS against the current (broken) code and
 * will PASS once the corresponding Phase 1 fix lands.
 */
console.log('Running P0 regression tests');

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

(async () => {
  const { SearchIndex } = await import('../../dist/src/lib/search/SearchIndex.js');
  const { HybridSearchEngine } = await import('../../dist/src/lib/search/HybridSearchEngine.js');
  const { expandQuery } = await import('../../dist/src/lib/search/queryExpansion.js');
  const { analyzeQuery } = await import('../../dist/src/lib/search/queryAnalyzer.js');

  // ---------------------------------------------------------------------------
  // Shared mock embedding: deterministic 384-dim vector from text hash
  // ---------------------------------------------------------------------------
  const mockEmbedding = {
    embed: async (text) => {
      const vec = new Array(384).fill(0);
      for (let i = 0; i < Math.min(text.length, 384); i++) {
        vec[i] = (text.charCodeAt(i) % 100) / 100;
      }
      return vec;
    },
    buildTransactionText: (tx) =>
      `${tx.payee_name} ${tx.category_name} ${tx.account_name} ${tx.notes} ${tx.amount} ${tx.date}`,
    getModelInfo: () => ({ model: 'mock', dimensions: 384, loaded: true }),
  };

  // ---------------------------------------------------------------------------
  // P0-1: Embedding cache roundtrip — cache hit must produce a valid number[]
  //        that results in a usable vector in the transactions table.
  // ---------------------------------------------------------------------------
  {
    console.log('  P0-1: Embedding cache roundtrip…');
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'p0-emb-cache-'));
    try {
      let embedCalls = 0;

      // buildTransactionText deliberately EXCLUDES `cleared` so that
      // changing `cleared` alters the content_hash (→ re-index) without
      // changing the embedding text (→ cache hit on the embedding_cache).
      const stableTextEmbed = {
        embed: async (text) => {
          embedCalls++;
          const vec = new Array(384).fill(0);
          for (let i = 0; i < Math.min(text.length, 384); i++) {
            vec[i] = (text.charCodeAt(i) % 100) / 100;
          }
          return vec;
        },
        buildTransactionText: (tx) =>
          `${tx.payee_name} ${tx.category_name} ${tx.account_name} ${tx.notes}`,
        getModelInfo: () => ({ model: 'mock', dimensions: 384, loaded: true }),
      };

      const idx = new SearchIndex(tmpDir, stableTextEmbed);
      idx.open();

      const tx1 = {
        id: 'tx-1', date: '2026-01-10', amount: -5000,
        notes: 'test note', payee_id: 'p1', payee_name: 'Store',
        category_id: 'c1', category_name: 'Food',
        account_id: 'a1', account_name: 'Checking',
        is_transfer: false, cleared: true,
      };

      // First index — cold embedding cache, embed() is called
      await idx.indexTransactions([tx1]);
      assert.equal(embedCalls, 1, 'First index should call embed once');

      // Read back the vector written on first pass
      const db = idx.getDb();
      const row1 = db.prepare(
        'SELECT vector_extract(embedding) AS vec FROM transactions WHERE id = ?'
      ).get('tx-1');
      assert.ok(row1?.vec, 'First index should write an embedding');

      // Verify embedding_cache has an entry
      const cacheCount = db.prepare('SELECT COUNT(*) AS c FROM embedding_cache').get().c;
      assert.equal(cacheCount, 1, 'Embedding cache should have 1 entry after first index');

      // Change `cleared` — this changes content_hash but NOT buildTransactionText output.
      // The row will be re-indexed, but the embedding text hash is identical → cache HIT.
      const tx1changed = { ...tx1, cleared: false };
      embedCalls = 0;
      await idx.indexTransactions([tx1changed]);

      // If the cache hit worked, embed() should NOT be called
      assert.equal(embedCalls, 0, 'Cache-hit re-index should NOT call embed()');

      // The vector written to transactions must still be valid (not a Buffer artifact)
      const row2 = db.prepare(
        'SELECT vector_extract(embedding) AS vec FROM transactions WHERE id = ?'
      ).get('tx-1');
      assert.ok(row2?.vec, 'Cache-hit re-index must still write a valid embedding');

      // Critical assertion: the vector must parse as a JSON number array,
      // not a serialized Buffer like {"type":"Buffer","data":[...]}
      const parsed = JSON.parse(row2.vec);
      assert.ok(Array.isArray(parsed), 'Extracted vector must be a JSON array');
      assert.equal(parsed.length, 384, 'Vector must have 384 dimensions');
      assert.equal(typeof parsed[0], 'number', 'Elements must be numbers');

      idx.close();
      console.log('    ✓ Embedding cache roundtrip produces valid vectors');
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  }

  // ---------------------------------------------------------------------------
  // P0-2: sanitizeFtsQuery must preserve expandQuery output semantics.
  //
  //   expandQuery("groceries") produces OR-grouped FTS5 syntax.
  //   After sanitization, those OR groups must still be intact so FTS5
  //   evaluates them correctly.
  // ---------------------------------------------------------------------------
  {
    console.log('  P0-2: sanitize + expand compatibility…');

    // We need access to sanitizeFtsQuery which is a private method.
    // Test the observable behavior: create a real FTS5 table and verify
    // that the expanded+sanitized query matches the expected rows.

    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'p0-fts-compat-'));
    try {
      const idx = new SearchIndex(tmpDir, mockEmbedding);
      idx.open();
      const db = idx.getDb();

      // Insert transaction rows (required for JOIN in executeFulltext)
      const insTx = db.prepare(
        `INSERT INTO transactions (id, date, amount, notes, payee_id, payee_name,
         category_id, category_name, account_id, account_name, is_transfer, cleared, content_hash)
         VALUES (?, ?, ?, ?, '', ?, '', ?, '', ?, 0, 1, '')`
      );
      insTx.run('t1', '2026-01-01', -5000, 'weekly run', 'Whole Foods', 'Groceries', 'Checking');
      insTx.run('t2', '2026-01-02', -3000, 'supermarket trip', 'Safeway', 'Groceries', 'Checking');
      insTx.run('t3', '2026-01-03', -120000, 'monthly rent', 'Landlord', 'Rent', 'Checking');

      // Insert FTS data
      db.prepare("INSERT INTO fts_transactions (txn_id, payee_name, category_name, account_name, notes) VALUES (?, ?, ?, ?, ?)")
        .run('t1', 'Whole Foods', 'Groceries', 'Checking', 'weekly run');
      db.prepare("INSERT INTO fts_transactions (txn_id, payee_name, category_name, account_name, notes) VALUES (?, ?, ?, ?, ?)")
        .run('t2', 'Safeway', 'Groceries', 'Checking', 'supermarket trip');
      db.prepare("INSERT INTO fts_transactions (txn_id, payee_name, category_name, account_name, notes) VALUES (?, ?, ?, ?, ?)")
        .run('t3', 'Landlord', 'Rent', 'Checking', 'monthly rent');

      // expandQuery("grocery") should produce something that matches both
      // "Groceries" (via grocery stem) and "supermarket" (via synonym).
      const expanded = expandQuery('grocery');

      // The expanded query should contain OR and synonyms
      assert.ok(
        expanded.includes('OR'),
        `expandQuery("grocery") should include OR but got: "${expanded}"`,
      );
      assert.ok(
        expanded.toLowerCase().includes('supermarket'),
        `expandQuery("grocery") should include "supermarket" but got: "${expanded}"`,
      );

      // Now use HybridSearchEngine which calls sanitizeFtsQuery internally.
      // If sanitize destroys the expansion, "supermarket" won't match the
      // FTS5 row that has "supermarket" in its notes.
      const engine = new HybridSearchEngine(
        () => db,
        async () => null, // no vector embedding needed
      );

      const response = await engine.search({
        text: 'grocery',
        mode: 'fulltext',
        limit: 10,
      });

      // t2 has "supermarket" in notes — if expansion works, it should match
      const matchedIds = response.results.map((r) => r.transaction.id);

      assert.ok(
        matchedIds.includes('t2'),
        `Expanded "grocery" query should match "supermarket" row (t2). Got: [${matchedIds}]`,
      );

      idx.close();
      console.log('    ✓ Expanded query preserves OR semantics through sanitization');
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  }

  // ---------------------------------------------------------------------------
  // P0-3: queryAnalyzer extracted amounts must be applied to search filters.
  //
  //   A query like "groceries over $50" should return only transactions
  //   where amount <= -5000 (Actual stores expenses as negative cents).
  //   Currently the analyzer extracts {min: 5000} but never wires it.
  // ---------------------------------------------------------------------------
  {
    console.log('  P0-3: extracted filters applied to search…');

    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'p0-filters-'));
    try {
      const idx = new SearchIndex(tmpDir, mockEmbedding);
      idx.open();
      const db = idx.getDb();

      // Seed transactions table directly
      const insert = db.prepare(`
        INSERT INTO transactions (id, date, amount, notes, payee_id, payee_name,
          category_id, category_name, account_id, account_name, is_transfer, cleared, content_hash)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, 1, '')
      `);
      insert.run('t1', '2026-01-10', -2000, '', 'p1', 'Store', 'c1', 'Groceries', 'a1', 'Checking');
      insert.run('t2', '2026-01-11', -8000, '', 'p1', 'Store', 'c1', 'Groceries', 'a1', 'Checking');
      insert.run('t3', '2026-01-12', -15000, '', 'p1', 'Store', 'c1', 'Groceries', 'a1', 'Checking');

      // Seed FTS
      const ftsInsert = db.prepare(
        'INSERT INTO fts_transactions (txn_id, payee_name, category_name, account_name, notes) VALUES (?, ?, ?, ?, ?)'
      );
      ftsInsert.run('t1', 'Store', 'Groceries', 'Checking', '');
      ftsInsert.run('t2', 'Store', 'Groceries', 'Checking', '');
      ftsInsert.run('t3', 'Store', 'Groceries', 'Checking', '');

      // Verify the analyzer extracts amounts
      const analysis = analyzeQuery('groceries over $50', false);
      assert.equal(analysis.intent, 'amount', 'Should detect amount intent');
      assert.ok(analysis.extractedAmounts, 'Should extract amounts');
      assert.ok(analysis.extractedAmounts.min, 'Should extract min amount');

      // Now search — if wired correctly, only t2 (-8000 = $80) and t3 (-15000 = $150)
      // should match "over $50" (amounts >= $50 in absolute value).
      const engine = new HybridSearchEngine(
        () => db,
        async () => null,
      );

      const response = await engine.search({
        text: 'groceries over $50',
        mode: 'fulltext',
        limit: 10,
      });

      const matchedIds = response.results.map((r) => r.transaction.id);
      const matchedAmounts = response.results.map((r) => r.transaction.amount);

      // t1 is -2000 ($20) — should NOT match "over $50"
      assert.ok(
        !matchedIds.includes('t1'),
        `"groceries over $50" should NOT return t1 (amount=-2000/$20). Got: [${matchedIds}] amounts: [${matchedAmounts}]`,
      );

      // t2 (-$80) and t3 (-$150) should match
      assert.ok(
        matchedIds.includes('t2') || matchedIds.includes('t3'),
        `"groceries over $50" should return t2 or t3. Got: [${matchedIds}]`,
      );

      idx.close();
      console.log('    ✓ Extracted amount filters are applied to search results');
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  }

  console.log('All P0 regression tests passed ✓');
})().catch((err) => {
  console.error('P0 regression test FAILED:', err?.message ?? err);
  console.error(err?.stack ?? '');
  process.exit(1);
});
