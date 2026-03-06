/**
 * Unit tests for query analyzer date-hint range derivation.
 */
console.log('Running query date-hint unit tests');

import assert from 'node:assert/strict';

(async () => {
  const { deriveDateRangeFromHints } = await import(
    '../../dist/src/lib/search/queryAnalyzer.js'
  );

  // ---------------------------------------------------------------------------
  // Test 1: ISO month hint -> full month date range
  // ---------------------------------------------------------------------------
  {
    const range = deriveDateRangeFromHints(['2026-02']);
    assert.deepEqual(
      range,
      { startDate: '2026-02-01', endDate: '2026-02-28' },
      'ISO month hint should produce full month date range',
    );
    console.log('  ✓ ISO month hint maps to month date range');
  }

  // ---------------------------------------------------------------------------
  // Test 2: relative "today" hint -> same-day range
  // ---------------------------------------------------------------------------
  {
    const now = new Date('2026-02-19T10:00:00.000Z');
    const range = deriveDateRangeFromHints(['today'], now);
    assert.deepEqual(
      range,
      { startDate: '2026-02-19', endDate: '2026-02-19' },
      '"today" should map to a same-day date range',
    );
    console.log('  ✓ today hint maps to same-day range');
  }

  // ---------------------------------------------------------------------------
  // Test 3: "recent" -> 30-day trailing window
  // ---------------------------------------------------------------------------
  {
    const now = new Date('2026-02-19T10:00:00.000Z');
    const range = deriveDateRangeFromHints(['recent'], now);
    assert.deepEqual(
      range,
      { startDate: '2026-01-20', endDate: '2026-02-19' },
      '"recent" should map to the last 30 days',
    );
    console.log('  ✓ recent hint maps to trailing 30-day range');
  }

  console.log('All query date-hint tests passed ✓');
})().catch((err) => {
  console.error('query date-hint test failed:', err);
  process.exit(1);
});
