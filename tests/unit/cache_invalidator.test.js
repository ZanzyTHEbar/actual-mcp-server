/**
 * Unit tests for CacheInvalidator
 *
 * Tests: isWriteTool identification, invalidateAfterWrite busts correct tags,
 * read tools are no-ops.
 */
console.log('Running CacheInvalidator unit tests');

import assert from 'node:assert/strict';

(async () => {
  const { isWriteTool, invalidateAfterWrite } = await import(
    '../../dist/src/lib/search/CacheInvalidator.js'
  );
  const { getResponseCache } = await import(
    '../../dist/src/lib/search/ResponseCache.js'
  );

  // ---------------------------------------------------------------------------
  // Test 1: isWriteTool — correctly identifies write tools
  // ---------------------------------------------------------------------------
  {
    const writeCases = [
      'actual_accounts_create',
      'actual_accounts_update',
      'actual_accounts_delete',
      'actual_transactions_create',
      'actual_transactions_update',
      'actual_transactions_delete',
      'actual_transactions_import',
      'actual_categories_create',
      'actual_categories_update',
      'actual_payees_create',
      'actual_payees_merge',
      'actual_rules_create',
      'actual_budgets_setAmount',
      'actual_bank_sync',
    ];

    for (const name of writeCases) {
      assert.equal(isWriteTool(name), true, `${name} should be a write tool`);
    }
    console.log('  ✓ isWriteTool returns true for write tools');
  }

  // ---------------------------------------------------------------------------
  // Test 2: isWriteTool — read tools return false
  // ---------------------------------------------------------------------------
  {
    const readCases = [
      'actual_accounts_list',
      'actual_categories_get',
      'actual_payees_get',
      'actual_transactions_get',
      'actual_transactions_filter',
      'actual_transactions_search_by_payee',
      'actual_budgets_getMonth',
      'actual_rules_get',
      'actual_server_info',
      'actual_hybrid_search',
      'nonexistent_tool',
    ];

    for (const name of readCases) {
      assert.equal(isWriteTool(name), false, `${name} should NOT be a write tool`);
    }
    console.log('  ✓ isWriteTool returns false for read tools');
  }

  // ---------------------------------------------------------------------------
  // Test 3: invalidateAfterWrite — busts correct cache tags
  // ---------------------------------------------------------------------------
  {
    const cache = getResponseCache();
    cache.clear();

    // Seed the cache with entries for different tags
    cache.set('ref:accounts', [{ id: 'a1' }], { ttlMs: 60_000, tags: ['accounts'] });
    cache.set('ref:categories', [{ id: 'c1' }], { ttlMs: 60_000, tags: ['categories'] });
    cache.set('ref:payees', [{ id: 'p1' }], { ttlMs: 60_000, tags: ['payees'] });
    cache.set('search:q1', { results: [] }, { ttlMs: 60_000, tags: ['search', 'transactions'] });

    // Simulate a transaction create — should bust transactions + search
    invalidateAfterWrite('actual_transactions_create');

    assert.notEqual(cache.peek('ref:accounts'), undefined, 'Accounts should survive txn write');
    assert.notEqual(cache.peek('ref:categories'), undefined, 'Categories should survive txn write');
    assert.notEqual(cache.peek('ref:payees'), undefined, 'Payees should survive txn write');
    assert.equal(cache.peek('search:q1'), undefined, 'Search cache should be busted by txn write');

    console.log('  ✓ invalidateAfterWrite busts correct tags for transactions_create');
  }

  // ---------------------------------------------------------------------------
  // Test 4: invalidateAfterWrite — account write busts account entries
  // ---------------------------------------------------------------------------
  {
    const cache = getResponseCache();
    cache.clear();

    cache.set('ref:accounts', [{ id: 'a1' }], { ttlMs: 60_000, tags: ['accounts'] });
    cache.set('ref:payees', [{ id: 'p1' }], { ttlMs: 60_000, tags: ['payees'] });

    invalidateAfterWrite('actual_accounts_create');

    assert.equal(cache.peek('ref:accounts'), undefined, 'Accounts should be busted');
    assert.notEqual(cache.peek('ref:payees'), undefined, 'Payees should survive');

    console.log('  ✓ invalidateAfterWrite busts correct tags for accounts_create');
  }

  // ---------------------------------------------------------------------------
  // Test 5: invalidateAfterWrite — no-op for read tools
  // ---------------------------------------------------------------------------
  {
    const cache = getResponseCache();
    cache.clear();

    cache.set('ref:accounts', [{ id: 'a1' }], { ttlMs: 60_000, tags: ['accounts'] });
    const vBefore = cache.version;

    invalidateAfterWrite('actual_accounts_list');

    assert.notEqual(cache.peek('ref:accounts'), undefined, 'Should not invalidate on read tool');
    assert.equal(cache.version, vBefore, 'Version should not change on read tool');

    console.log('  ✓ invalidateAfterWrite is no-op for read tools');
  }

  // ---------------------------------------------------------------------------
  // Test 6: invalidateAfterWrite — bank_sync busts transactions + accounts + search
  // ---------------------------------------------------------------------------
  {
    const cache = getResponseCache();
    cache.clear();

    cache.set('ref:accounts', [{ id: 'a1' }], { ttlMs: 60_000, tags: ['accounts'] });
    cache.set('ref:categories', [{ id: 'c1' }], { ttlMs: 60_000, tags: ['categories'] });
    cache.set('search:q1', { results: [] }, { ttlMs: 60_000, tags: ['search'] });
    cache.set('txn:all', [], { ttlMs: 60_000, tags: ['transactions'] });

    invalidateAfterWrite('actual_bank_sync');

    assert.equal(cache.peek('ref:accounts'), undefined, 'Accounts busted by bank_sync');
    assert.notEqual(cache.peek('ref:categories'), undefined, 'Categories survive bank_sync');
    assert.equal(cache.peek('search:q1'), undefined, 'Search busted by bank_sync');
    assert.equal(cache.peek('txn:all'), undefined, 'Transactions busted by bank_sync');

    console.log('  ✓ invalidateAfterWrite for bank_sync busts accounts + transactions + search');
  }

  console.log('All CacheInvalidator tests passed ✓');
})().catch((err) => {
  console.error('CacheInvalidator test failed:', err);
  process.exit(1);
});
