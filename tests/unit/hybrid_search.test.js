/**
 * Unit tests for HybridSearchEngine
 *
 * Tests: FTS-only mode, vector-only mode, metadata-only mode, hybrid RRF,
 * empty results, filter combinations.
 *
 * Uses a temp directory with a fully populated SearchIndex + mock embeddings.
 */
console.log('Running HybridSearchEngine unit tests');

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

(async () => {
  const { SearchIndex } = await import('../../dist/src/lib/search/SearchIndex.js');
  const { HybridSearchEngine } = await import('../../dist/src/lib/search/HybridSearchEngine.js');
  const { buildTransactionText } = await import('../../dist/src/lib/search/EmbeddingPipeline.js');

  // Deterministic fake embeddings — make groceries similar to each other
  const GROCERY_VEC = new Array(384).fill(0).map((_, i) => (i < 50 ? 0.8 : 0.1));
  const RENT_VEC = new Array(384).fill(0).map((_, i) => (i >= 50 && i < 100 ? 0.8 : 0.1));
  const SALARY_VEC = new Array(384).fill(0).map((_, i) => (i >= 100 && i < 150 ? 0.8 : 0.1));

  const mockEmbedding = {
    embed: async (text) => {
      const lower = text.toLowerCase();
      if (lower.includes('grocery') || lower.includes('food') || lower.includes('whole foods') || lower.includes('trader')) {
        return GROCERY_VEC;
      }
      if (lower.includes('rent') || lower.includes('landlord') || lower.includes('housing')) {
        return RENT_VEC;
      }
      if (lower.includes('salary') || lower.includes('paycheck') || lower.includes('employer')) {
        return SALARY_VEC;
      }
      return new Array(384).fill(0).map((_, i) => ((i * 7 + text.length) % 100) / 100);
    },
    buildTransactionText,
    getModelInfo: () => ({
      model: 'mock-model',
      dimensions: 384,
      loaded: true,
    }),
  };

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hybrid-search-test-'));

  try {
    // Setup: create and populate index
    const index = new SearchIndex(tmpDir, mockEmbedding);
    index.open();

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
      { id: 'pay-2', name: 'Trader Joes' },
      { id: 'pay-3', name: 'Landlord' },
      { id: 'pay-4', name: 'Employer Inc' },
    ]);

    const txns = [
      {
        id: 'txn-1', date: '2026-01-10', amount: -5000,
        notes: 'Weekly grocery shopping', payee_id: 'pay-1', payee_name: 'Whole Foods',
        category_id: 'cat-1', category_name: 'Groceries',
        account_id: 'acc-1', account_name: 'Checking',
        is_transfer: false, cleared: true,
      },
      {
        id: 'txn-2', date: '2026-01-15', amount: -3500,
        notes: 'Organic food run', payee_id: 'pay-2', payee_name: 'Trader Joes',
        category_id: 'cat-1', category_name: 'Groceries',
        account_id: 'acc-1', account_name: 'Checking',
        is_transfer: false, cleared: true,
      },
      {
        id: 'txn-3', date: '2026-02-01', amount: -120000,
        notes: 'February rent payment', payee_id: 'pay-3', payee_name: 'Landlord',
        category_id: 'cat-2', category_name: 'Rent',
        account_id: 'acc-1', account_name: 'Checking',
        is_transfer: false, cleared: true,
      },
      {
        id: 'txn-4', date: '2026-02-01', amount: 500000,
        notes: 'Monthly paycheck', payee_id: 'pay-4', payee_name: 'Employer Inc',
        category_id: 'cat-3', category_name: 'Salary',
        account_id: 'acc-1', account_name: 'Checking',
        is_transfer: false, cleared: false,
      },
      {
        id: 'txn-5', date: '2026-01-20', amount: -1500,
        notes: 'Quick groceries', payee_id: 'pay-1', payee_name: 'Whole Foods',
        category_id: 'cat-1', category_name: 'Groceries',
        account_id: 'acc-2', account_name: 'Savings',
        is_transfer: false, cleared: true,
      },
    ];

    await index.indexTransactions(txns);

    const engine = new HybridSearchEngine(() => index.getDb(), mockEmbedding.embed);

    // ---------------------------------------------------------------------------
    // Test 1: Fulltext search — finds keyword matches
    // ---------------------------------------------------------------------------
    {
      const response = await engine.search({
        text: 'grocery',
        mode: 'fulltext',
        limit: 10,
      });

      // FTS5 exact match: "grocery" matches txn-1 ("grocery shopping") 
      // but NOT txn-5 ("groceries") without prefix. At least 1 match expected.
      assert.ok(response.results.length >= 1, `Expected >=1 grocery matches, got ${response.results.length}`);
      const ids = response.results.map((r) => r.transaction.id);
      assert.ok(ids.includes('txn-1'), 'Should find txn-1 (Weekly grocery shopping)');
      assert.ok(response.timing.totalMs >= 0, 'Should have timing');
      console.log(`  ✓ Fulltext search: ${response.results.length} results for "grocery"`);
    }

    // ---------------------------------------------------------------------------
    // Test 2: Fulltext search — no matches
    // ---------------------------------------------------------------------------
    {
      const response = await engine.search({
        text: 'xyznonexistent',
        mode: 'fulltext',
        limit: 10,
      });

      assert.equal(response.results.length, 0, 'Should return no results for nonsense query');
      console.log('  ✓ Fulltext search: 0 results for nonsense query');
    }

    // ---------------------------------------------------------------------------
    // Test 3: Metadata-only search — filter by account
    // ---------------------------------------------------------------------------
    {
      const response = await engine.search({
        mode: 'metadata',
        filters: { accountId: 'acc-2' },
        limit: 10,
      });

      assert.equal(response.results.length, 1, 'Should find 1 transaction in Savings');
      assert.equal(response.results[0].transaction.id, 'txn-5');
      console.log('  ✓ Metadata search: filter by accountId');
    }

    // ---------------------------------------------------------------------------
    // Test 4: Metadata-only — filter by date range
    // ---------------------------------------------------------------------------
    {
      const response = await engine.search({
        mode: 'metadata',
        filters: { startDate: '2026-02-01', endDate: '2026-02-28' },
        limit: 10,
      });

      assert.equal(response.results.length, 2, 'Should find 2 transactions in February');
      const ids = response.results.map((r) => r.transaction.id).sort();
      assert.deepEqual(ids, ['txn-3', 'txn-4']);
      console.log('  ✓ Metadata search: filter by date range');
    }

    // ---------------------------------------------------------------------------
    // Test 5: Metadata-only — filter by amount range
    // ---------------------------------------------------------------------------
    {
      const response = await engine.search({
        mode: 'metadata',
        filters: { minAmount: -6000, maxAmount: -1000 },
        limit: 10,
      });

      // txn-1: -5000, txn-2: -3500, txn-5: -1500 are in range
      assert.ok(response.results.length >= 2, `Expected >=2 in amount range, got ${response.results.length}`);
      for (const r of response.results) {
        assert.ok(r.transaction.amount >= -6000 && r.transaction.amount <= -1000,
          `Amount ${r.transaction.amount} should be in range`);
      }
      console.log(`  ✓ Metadata search: filter by amount range (${response.results.length} results)`);
    }

    // ---------------------------------------------------------------------------
    // Test 6: Metadata-only — no filters returns most recent
    // ---------------------------------------------------------------------------
    {
      const response = await engine.search({
        mode: 'metadata',
        limit: 3,
      });

      assert.equal(response.results.length, 3, 'Should return 3 most recent');
      console.log('  ✓ Metadata search: no filters returns most recent');
    }

    // ---------------------------------------------------------------------------
    // Test 7: Hybrid search — combines FTS + vector
    // ---------------------------------------------------------------------------
    {
      const response = await engine.search({
        text: 'grocery food shopping',
        mode: 'hybrid',
        limit: 5,
      });

      assert.ok(response.results.length >= 1, 'Hybrid should return results');
      // Grocery transactions should rank high
      const topIds = response.results.slice(0, 3).map((r) => r.transaction.id);
      const hasGrocery = topIds.some((id) => ['txn-1', 'txn-2', 'txn-5'].includes(id));
      assert.ok(hasGrocery, 'Top results should include grocery transactions');
      assert.ok(response.timing.embeddingMs !== undefined, 'Should report embedding timing');
      console.log(`  ✓ Hybrid search: ${response.results.length} results for "grocery food shopping"`);
    }

    // ---------------------------------------------------------------------------
    // Test 8: Hybrid with metadata filters
    // ---------------------------------------------------------------------------
    {
      const response = await engine.search({
        text: 'grocery',
        mode: 'hybrid',
        filters: { accountId: 'acc-1' },
        limit: 10,
      });

      // txn-5 is in acc-2, so it should be filtered out
      for (const r of response.results) {
        assert.equal(r.transaction.account_id, 'acc-1',
          `All results should be from acc-1, got ${r.transaction.account_id}`);
      }
      console.log(`  ✓ Hybrid search with account filter: ${response.results.length} results`);
    }

    // ---------------------------------------------------------------------------
    // Test 9: Hybrid with no text falls back to metadata
    // ---------------------------------------------------------------------------
    {
      const response = await engine.search({
        mode: 'hybrid',
        filters: { categoryId: 'cat-2' },
        limit: 10,
      });

      assert.equal(response.results.length, 1, 'Should find rent transaction');
      assert.equal(response.results[0].transaction.id, 'txn-3');
      console.log('  ✓ Hybrid with no text falls back to metadata');
    }

    // ---------------------------------------------------------------------------
    // Test 10: Search result structure validation
    // ---------------------------------------------------------------------------
    {
      const response = await engine.search({
        text: 'rent',
        mode: 'fulltext',
        limit: 5,
      });

      if (response.results.length > 0) {
        const result = response.results[0];
        assert.ok('transaction' in result, 'Result should have transaction');
        assert.ok('score' in result, 'Result should have score');
        assert.ok('matchedBy' in result, 'Result should have matchedBy');
        assert.ok(Array.isArray(result.matchedBy), 'matchedBy should be array');

        const txn = result.transaction;
        assert.ok('id' in txn, 'Transaction should have id');
        assert.ok('date' in txn, 'Transaction should have date');
        assert.ok('amount' in txn, 'Transaction should have amount');
        assert.ok('payee_name' in txn, 'Transaction should have payee_name');
        assert.ok('category_name' in txn, 'Transaction should have category_name');
      }
      console.log('  ✓ Search result structure is valid');
    }

    // ---------------------------------------------------------------------------
    // Test 11: Timing metadata
    // ---------------------------------------------------------------------------
    {
      const response = await engine.search({
        text: 'grocery',
        mode: 'hybrid',
        limit: 5,
      });

      assert.ok(typeof response.timing.totalMs === 'number', 'totalMs should be number');
      assert.ok(response.timing.totalMs >= 0, 'totalMs should be non-negative');
      assert.ok(typeof response.totalMatched === 'number', 'totalMatched should be number');
      assert.deepEqual(response.query.text, 'grocery', 'Query should be echoed back');
      console.log('  ✓ Timing metadata is present');
    }

    index.close();

  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }

  console.log('All HybridSearchEngine tests passed ✓');
})().catch((err) => {
  console.error('HybridSearchEngine test failed:', err?.message ?? err, err?.stack ?? '');
  process.exit(1);
});
