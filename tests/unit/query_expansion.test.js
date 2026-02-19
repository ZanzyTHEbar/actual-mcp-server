/**
 * Unit tests: queryExpansion + queryAnalyzer
 */
import assert from 'node:assert/strict';

console.log('Running queryExpansion + queryAnalyzer tests');

// ---------------------------------------------------------------------------
// queryExpansion tests
// ---------------------------------------------------------------------------
{
  const { expandQuery, getSynonyms, SYNONYM_GROUP_COUNT, UNIQUE_TERM_COUNT } =
    await import('../../dist/src/lib/search/queryExpansion.js');

  // Test 1: basic synonym expansion
  {
    const expanded = expandQuery('groceries');
    assert.ok(expanded.includes('grocery'), `Should expand "groceries" to include "grocery": ${expanded}`);
    assert.ok(expanded.includes('supermarket'), `Should include "supermarket": ${expanded}`);
    console.log('  ✓ Basic synonym expansion (groceries)');
  }

  // Test 2: bigram expansion
  {
    const expanded = expandQuery('fast food');
    assert.ok(
      expanded.includes('drive-thru') || expanded.includes('drive through'),
      `Should expand "fast food" bigram: ${expanded}`,
    );
    console.log('  ✓ Bigram expansion (fast food)');
  }

  // Test 3: no expansion for unknown terms
  {
    const expanded = expandQuery('xyzzy123');
    assert.equal(expanded, 'xyzzy123', 'Unknown terms should pass through unchanged');
    console.log('  ✓ Unknown terms pass through unchanged');
  }

  // Test 4: mixed query preserves non-synonym words
  {
    const expanded = expandQuery('coffee last month');
    assert.ok(expanded.includes('cafe') || expanded.includes('café'), 'Should expand coffee');
    assert.ok(expanded.includes('last'), 'Non-synonym words preserved');
    assert.ok(expanded.includes('month'), 'Non-synonym words preserved');
    console.log('  ✓ Mixed query preserves non-synonym words');
  }

  // Test 5: empty query returns empty
  {
    assert.equal(expandQuery(''), '');
    assert.equal(expandQuery(undefined), undefined);
    console.log('  ✓ Empty/undefined returns as-is');
  }

  // Test 6: getSynonyms returns group members
  {
    const syns = getSynonyms('uber');
    assert.ok(syns.includes('lyft'), 'uber synonyms should include lyft');
    assert.ok(syns.includes('taxi'), 'uber synonyms should include taxi');
    console.log('  ✓ getSynonyms returns correct group');
  }

  // Test 7: dictionary stats are populated
  {
    assert.ok(SYNONYM_GROUP_COUNT > 20, `Should have >20 groups, got ${SYNONYM_GROUP_COUNT}`);
    assert.ok(UNIQUE_TERM_COUNT > 100, `Should have >100 terms, got ${UNIQUE_TERM_COUNT}`);
    console.log(`  ✓ Dictionary stats: ${SYNONYM_GROUP_COUNT} groups, ${UNIQUE_TERM_COUNT} terms`);
  }
}

// ---------------------------------------------------------------------------
// queryAnalyzer tests
// ---------------------------------------------------------------------------
{
  const { analyzeQuery } = await import('../../dist/src/lib/search/queryAnalyzer.js');

  // Test 8: amount query detection
  {
    const analysis = analyzeQuery('over $50', false);
    assert.equal(analysis.intent, 'amount', 'Should detect amount intent');
    assert.ok(analysis.extractedAmounts?.min, 'Should extract minimum amount');
    assert.equal(analysis.extractedAmounts.min, 5000, 'Min should be 5000 cents');
    console.log('  ✓ Amount query: "over $50"');
  }

  // Test 9: date query detection
  {
    const analysis = analyzeQuery('last month expenses', false);
    assert.equal(analysis.intent, 'date', 'Should detect date intent');
    assert.ok(analysis.extractedDateHints?.length > 0, 'Should have date hints');
    console.log('  ✓ Date query: "last month expenses"');
  }

  // Test 10: exact name detection
  {
    const analysis = analyzeQuery('Starbucks', false);
    assert.equal(analysis.intent, 'exact_name', 'Should detect exact name');
    assert.ok(analysis.ftsWeight > 1.0, 'FTS weight should be boosted for exact names');
    console.log('  ✓ Exact name query: "Starbucks"');
  }

  // Test 11: natural language
  {
    const analysis = analyzeQuery('where did I spend the most on eating out', false);
    assert.equal(analysis.intent, 'natural', 'Should classify as natural language');
    console.log('  ✓ Natural language query');
  }

  // Test 12: filter-only (no text)
  {
    const analysis = analyzeQuery('', true);
    assert.equal(analysis.intent, 'filter_only');
    assert.equal(analysis.recommendedMode, 'metadata');
    console.log('  ✓ Filter-only (no text, has filters)');
  }

  // Test 13: between amount pattern
  {
    const analysis = analyzeQuery('between $20 and $100', false);
    assert.equal(analysis.intent, 'amount');
    assert.equal(analysis.extractedAmounts?.min, 2000);
    assert.equal(analysis.extractedAmounts?.max, 10000);
    console.log('  ✓ Between amount: "$20 and $100"');
  }
}

console.log('All queryExpansion + queryAnalyzer tests passed ✓');
