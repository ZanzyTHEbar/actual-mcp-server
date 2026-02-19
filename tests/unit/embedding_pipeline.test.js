/**
 * Unit tests for EmbeddingPipeline
 *
 * Tests: buildTransactionText output format, getModelInfo().
 * NOTE: embed() / embedBatch() require the HF model download (~23MB) which
 * is too slow for CI unit tests. Those are tested via integration tests.
 * Here we test the pure functions that don't need the model.
 */
console.log('Running EmbeddingPipeline unit tests');

import assert from 'node:assert/strict';

(async () => {
  const { buildTransactionText, getModelInfo } = await import(
    '../../dist/src/lib/search/EmbeddingPipeline.js'
  );

  // ---------------------------------------------------------------------------
  // Test 1: buildTransactionText — full transaction
  // ---------------------------------------------------------------------------
  {
    const text = buildTransactionText({
      payee_name: 'Whole Foods Market',
      category_name: 'Groceries',
      account_name: 'Checking',
      notes: 'Weekly grocery run',
      amount: -8523,
      date: '2026-01-15',
    });

    assert.ok(text.includes('Whole Foods Market'), 'Should include payee name');
    assert.ok(text.includes('Groceries'), 'Should include category name');
    assert.ok(text.includes('Checking'), 'Should include account name');
    assert.ok(text.includes('Weekly grocery run'), 'Should include notes');
    assert.ok(text.includes('expense'), 'Negative amount should be labeled expense');
    assert.ok(text.includes('85.23'), 'Should include dollar amount');
    assert.ok(text.includes('2026-01-15'), 'Should include date');
    console.log('  ✓ buildTransactionText — full transaction');
  }

  // ---------------------------------------------------------------------------
  // Test 2: buildTransactionText — income transaction
  // ---------------------------------------------------------------------------
  {
    const text = buildTransactionText({
      payee_name: 'Employer Inc',
      category_name: 'Salary',
      account_name: 'Checking',
      notes: '',
      amount: 500000,
      date: '2026-02-01',
    });

    assert.ok(text.includes('income'), 'Positive amount should be labeled income');
    assert.ok(text.includes('5000.00'), 'Should include dollar amount');
    assert.ok(!text.includes('expense'), 'Should NOT include expense');
    console.log('  ✓ buildTransactionText — income transaction');
  }

  // ---------------------------------------------------------------------------
  // Test 3: buildTransactionText — empty fields
  // ---------------------------------------------------------------------------
  {
    const text = buildTransactionText({
      payee_name: '',
      category_name: '',
      account_name: '',
      notes: '',
      amount: -100,
      date: '2026-01-01',
    });

    // Should still produce something (amount + date at minimum)
    assert.ok(text.includes('expense'), 'Should include type');
    assert.ok(text.includes('1.00'), 'Should include amount');
    assert.ok(text.includes('2026-01-01'), 'Should include date');
    // Empty strings should not produce leading pipes
    assert.ok(!text.startsWith(' | '), 'Should not start with separator');
    console.log('  ✓ buildTransactionText — empty fields');
  }

  // ---------------------------------------------------------------------------
  // Test 4: buildTransactionText — delimiter consistency
  // ---------------------------------------------------------------------------
  {
    const text = buildTransactionText({
      payee_name: 'Amazon',
      category_name: 'Shopping',
      account_name: 'Credit Card',
      notes: 'Prime order',
      amount: -2999,
      date: '2026-01-20',
    });

    const parts = text.split(' | ');
    assert.ok(parts.length >= 5, `Expected at least 5 parts, got ${parts.length}`);
    console.log('  ✓ buildTransactionText — delimiter consistency');
  }

  // ---------------------------------------------------------------------------
  // Test 5: getModelInfo — returns expected structure
  // ---------------------------------------------------------------------------
  {
    const info = getModelInfo();
    assert.ok(typeof info.model === 'string', 'model should be string');
    assert.ok(typeof info.dimensions === 'number', 'dimensions should be number');
    assert.ok(typeof info.loaded === 'boolean', 'loaded should be boolean');
    assert.equal(info.dimensions, 384, 'Default dimensions should be 384');
    assert.equal(info.loaded, false, 'Model should not be loaded yet');
    console.log('  ✓ getModelInfo returns correct structure');
  }

  console.log('All EmbeddingPipeline tests passed ✓');
})().catch((err) => {
  console.error('EmbeddingPipeline test failed:', err);
  process.exit(1);
});
