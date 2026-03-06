import { describe, expect, it } from 'vitest';
import { parseBudgetRegistry } from '../../src/lib/budget-registry.js';

describe('budget registry validation', () => {
  it('uses named budgets when the default sync id is absent', () => {
    const registry = parseBudgetRegistry(
      {
        BUDGET_1_NAME: 'Office',
        BUDGET_1_SERVER_URL: 'http://localhost:5006',
        BUDGET_1_SYNC_ID: 'office-budget-456',
      },
      {
        serverUrl: 'http://localhost:5006',
        password: '',
        syncId: '',
      },
    );

    expect([...registry.values()]).toHaveLength(1);
    expect([...registry.values()][0].name).toBe('Office');
  });

  it('rejects duplicate case-insensitive budget names', () => {
    expect(() =>
      parseBudgetRegistry(
        {
          ACTUAL_BUDGET_SYNC_ID: 'default-budget',
          BUDGET_DEFAULT_NAME: 'Office',
          BUDGET_1_NAME: 'office',
          BUDGET_1_SYNC_ID: 'office-budget-456',
        },
        {
          serverUrl: 'http://localhost:5006',
          password: '',
          syncId: 'default-budget',
        },
      )
    ).toThrow(/Duplicate budget name/i);
  });

  it('rejects an empty registry', () => {
    expect(() =>
      parseBudgetRegistry(
        {},
        {
          serverUrl: 'http://localhost:5006',
          password: '',
          syncId: '',
        },
      )
    ).toThrow(/No valid budgets configured/i);
  });
});
