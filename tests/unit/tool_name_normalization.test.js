/**
 * Unit tests for canonical tool-name normalization and coverage stats.
 */
console.log('Running tool-name normalization unit tests');

import assert from 'node:assert/strict';

(async () => {
  const { normalizeToolName } = await import(
    '../../dist/src/lib/toolNameNormalization.js'
  );
  const { default: actualToolsManager } = await import(
    '../../dist/src/actualToolsManager.js'
  );

  // ---------------------------------------------------------------------------
  // Test 1: legacy alias normalizes to canonical name
  // ---------------------------------------------------------------------------
  {
    assert.equal(
      normalizeToolName('actual_budgets_updates_batch'),
      'actual_budget_updates_batch',
      'Legacy batch budget alias should normalize to canonical tool name',
    );
    assert.equal(
      normalizeToolName('actual_transactions_get'),
      'actual_transactions_get',
      'Canonical names should remain unchanged',
    );
    console.log('  ✓ normalizeToolName maps legacy aliases correctly');
  }

  // ---------------------------------------------------------------------------
  // Test 2: coverage stats treat canonical mapped tools as covered
  // ---------------------------------------------------------------------------
  {
    const stats = actualToolsManager.getCoverageStats();
    assert.ok(
      !stats.missingToolsList.includes('actual_budget_updates_batch'),
      'Canonical budget batch tool should not be reported as missing',
    );
    assert.ok(
      stats.coveragePercent <= 100,
      `Coverage percent should be <= 100, got ${stats.coveragePercent}`,
    );
    console.log('  ✓ getCoverageStats uses canonical mapped tool names');
  }

  console.log('All tool-name normalization tests passed ✓');
})().catch((err) => {
  console.error('tool-name normalization test failed:', err);
  process.exit(1);
});
