import { describe, it, expect, beforeEach, vi } from 'vitest';

// Mock logger
vi.mock('../../src/logger.js', () => ({
  default: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
}));

// Mock config with a proxy object that allows mutation from tests
vi.mock('../../src/config.js', () => {
  return {
    default: new Proxy({} as Record<string, unknown>, {
      get(target, prop) { return target[prop as string]; },
      set(target, prop, value) { target[prop as string] = value; return true; },
      deleteProperty(target, prop) { delete target[prop as string]; return true; },
    }),
  };
});

import config from '../../src/config.js';
import { canAccessBudget, getAllowedBudgets, resetAclCache } from '../../src/auth/budget-acl.js';
import type { AuthIdentity } from '../../src/auth/types.js';

// Helper to set config values
function setAcl(acl: Record<string, string[]> | undefined) {
  if (acl === undefined) {
    delete (config as any).AUTH_BUDGET_ACL;
  } else {
    (config as any).AUTH_BUDGET_ACL = JSON.stringify(acl);
  }
}

describe('Budget ACL', () => {
  beforeEach(() => {
    resetAclCache();
    delete (config as any).AUTH_BUDGET_ACL;
  });

  describe('canAccessBudget', () => {
    it('should allow all access when no ACL is configured', () => {
      const identity: AuthIdentity = { userId: 'alice@example.com' };
      expect(canAccessBudget(identity, 'budget-123')).toBe(true);
    });

    it('should allow access via wildcard (*:*)', () => {
      setAcl({ '*': ['*'] });
      const identity: AuthIdentity = { userId: 'anyone' };
      expect(canAccessBudget(identity, 'any-budget')).toBe(true);
    });

    it('should allow access via wildcard for specific budget', () => {
      setAcl({ '*': ['budget-public'] });
      const identity: AuthIdentity = { userId: 'anyone' };
      expect(canAccessBudget(identity, 'budget-public')).toBe(true);
      expect(canAccessBudget(identity, 'budget-private')).toBe(false);
    });

    it('should allow access via userId match', () => {
      setAcl({ 'alice@example.com': ['budget-1', 'budget-2'] });
      const identity: AuthIdentity = { userId: 'alice@example.com' };
      expect(canAccessBudget(identity, 'budget-1')).toBe(true);
      expect(canAccessBudget(identity, 'budget-2')).toBe(true);
      expect(canAccessBudget(identity, 'budget-3')).toBe(false);
    });

    it('should allow access via email when different from userId', () => {
      setAcl({ 'alice@example.com': ['budget-1'] });
      const identity: AuthIdentity = {
        userId: 'alice-uid',
        email: 'alice@example.com',
      };
      expect(canAccessBudget(identity, 'budget-1')).toBe(true);
    });

    it('should allow access via group membership', () => {
      setAcl({
        'group:finance': ['budget-finance'],
        'group:admin': ['*'],
      });
      const financeUser: AuthIdentity = { userId: 'bob', groups: ['finance'] };
      const adminUser: AuthIdentity = { userId: 'charlie', groups: ['admin'] };
      const noGroupUser: AuthIdentity = { userId: 'dave' };

      expect(canAccessBudget(financeUser, 'budget-finance')).toBe(true);
      expect(canAccessBudget(financeUser, 'budget-other')).toBe(false);
      expect(canAccessBudget(adminUser, 'budget-anything')).toBe(true);
      expect(canAccessBudget(noGroupUser, 'budget-finance')).toBe(false);
    });

    it('should deny access when user not in ACL', () => {
      setAcl({ 'alice@example.com': ['budget-1'] });
      const identity: AuthIdentity = { userId: 'bob@example.com' };
      expect(canAccessBudget(identity, 'budget-1')).toBe(false);
    });

    it('should handle invalid ACL JSON gracefully', () => {
      (config as any).AUTH_BUDGET_ACL = 'not-valid-json';
      const identity: AuthIdentity = { userId: 'alice' };
      expect(canAccessBudget(identity, 'any-budget')).toBe(true);
    });

    it('should allow userId wildcard budget access', () => {
      setAcl({ 'alice@example.com': ['*'] });
      const identity: AuthIdentity = { userId: 'alice@example.com' };
      expect(canAccessBudget(identity, 'any-budget')).toBe(true);
    });
  });

  describe('getAllowedBudgets', () => {
    it('should return null when no ACL configured', () => {
      const identity: AuthIdentity = { userId: 'alice' };
      expect(getAllowedBudgets(identity)).toBeNull();
    });

    it('should return budgets from all matching sources', () => {
      setAcl({
        '*': ['budget-public'],
        'alice@example.com': ['budget-alice'],
        'group:finance': ['budget-finance'],
      });
      const identity: AuthIdentity = {
        userId: 'alice@example.com',
        groups: ['finance'],
      };
      const budgets = getAllowedBudgets(identity);
      expect(budgets).toContain('budget-public');
      expect(budgets).toContain('budget-alice');
      expect(budgets).toContain('budget-finance');
    });

    it('should deduplicate budget IDs', () => {
      setAcl({
        '*': ['budget-1'],
        'alice': ['budget-1', 'budget-2'],
      });
      const identity: AuthIdentity = { userId: 'alice' };
      const budgets = getAllowedBudgets(identity)!;
      expect(budgets.filter((b) => b === 'budget-1')).toHaveLength(1);
    });
  });
});
