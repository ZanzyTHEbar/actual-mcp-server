// src/actualToolsManager.ts
import * as ActualApi from '@actual-app/api';
import logger from './logger.js';
import { z } from 'zod';
import { invalidateAfterWrite, isWriteTool } from './lib/search/CacheInvalidator.js';

import type { ZodTypeAny } from 'zod';
import type { ToolDefinition } from '../types/tool.d.js';

// ✅ List of tools already implemented in this class.
// Adding the tool name here is considered fully implemented.
const IMPLEMENTED_TOOLS = [
  'actual_accounts_close',
  'actual_accounts_create',
  'actual_accounts_delete',
  'actual_accounts_get_balance',
  'actual_accounts_list',
  'actual_accounts_reopen',
  'actual_accounts_update',
  'actual_bank_sync',
  'actual_budgets_get_all',
  'actual_budgets_getMonth',
  'actual_budgets_getMonths',
  'actual_budgets_holdForNextMonth',
  'actual_budgets_resetHold',
  'actual_budgets_setAmount',
  'actual_budgets_setCarryover',
  'actual_budgets_transfer',
  'actual_budgets_updates_batch',
  'actual_categories_create',
  'actual_categories_delete',
  'actual_categories_get',
  'actual_categories_update',
  'actual_category_groups_create',
  'actual_category_groups_delete',
  'actual_category_groups_get',
  'actual_category_groups_update',
  'actual_payees_create',
  'actual_payees_delete',
  'actual_payees_get',
  'actual_payees_merge',
  'actual_payees_update',
  'actual_payee_rules_get',
  'actual_query_run',
  'actual_rules_create',
  'actual_rules_create_or_update',
  'actual_rules_delete',
  'actual_rules_get',
  'actual_rules_update',
  'actual_transactions_create',
  'actual_transactions_delete',
  'actual_transactions_filter',
  'actual_transactions_get',
  'actual_transactions_import',
  'actual_transactions_search_by_amount',
  'actual_transactions_search_by_category',
  'actual_transactions_search_by_month',
  'actual_transactions_search_by_payee',
  'actual_transactions_summary_by_category',
  'actual_transactions_summary_by_payee',
  'actual_transactions_uncategorized',
  'actual_transactions_update',
  'actual_transactions_update_batch',
  'actual_hybrid_search',
  'actual_server_info',
  'actual_session_close',
  'actual_session_list',
  'actual_tool_registry',
  'actual_tool_call',
];

// 🔑 Mapping of Actual API function names → your MCP tool names
// This allows us to compare what exists in the API vs. what it has been wrapped.
const API_TOOL_MAP: Record<string, string> = {
  getAccounts: 'actual_accounts_list',
  createAccount: 'actual_accounts_create',
  updateAccount: 'actual_accounts_update',
  deleteAccount: 'actual_accounts_delete',
  getAccountBalance: 'actual_accounts_get_balance',
  getTransactions: 'actual_transactions_get',
  addTransactions: 'actual_transactions_create',
  importTransactions: 'actual_transactions_import',
  updateTransaction: 'actual_transactions_update',
  deleteTransaction: 'actual_transactions_delete',
  getBudgetMonths: 'actual_budgets_getMonths',
  getBudgetMonth: 'actual_budgets_getMonth',
  setBudgetAmount: 'actual_budgets_setAmount',
  setBudgetCarryover: 'actual_budgets_setCarryover',
  getCategories: 'actual_categories_get',
  createCategory: 'actual_categories_create',
  updateCategory: 'actual_categories_update',
  deleteCategory: 'actual_categories_delete',
  getPayees: 'actual_payees_get',
  createPayee: 'actual_payees_create',
  updatePayee: 'actual_payees_update',
  deletePayee: 'actual_payees_delete',
  mergePayees: 'actual_payees_merge',
  getPayeeRules: 'actual_payee_rules_get',
  batchBudgetUpdates: 'actual_budget_updates_batch',
  holdBudgetForNextMonth: 'actual_budgets_holdForNextMonth',
  resetBudgetHold: 'actual_budgets_resetHold',
  getRules: 'actual_rules_get',
  createRule: 'actual_rules_create',
  updateRule: 'actual_rules_update',
  deleteRule: 'actual_rules_delete',
  closeAccount: 'actual_accounts_close',
  reopenAccount: 'actual_accounts_reopen',
  getCategoryGroups: 'actual_category_groups_get',
  createCategoryGroup: 'actual_category_groups_create',
  updateCategoryGroup: 'actual_category_groups_update',
  deleteCategoryGroup: 'actual_category_groups_delete',
};

// Define Account schema for validation (simplified example)
const AccountSchema = z.object({
  id: z.string().optional(),
  name: z.string(),
  type: z.string(), // Consider enum if you have fixed valid types
  offbudget: z.boolean().optional().default(false),
  closed: z.boolean().optional().default(false),
});

// Input schema for get_accounts - no args
const GetAccountsInputSchema = z.object({});

// Input schema for get_account_balance
const GetAccountBalanceInputSchema = z.object({
  id: z.string().optional().describe('Account ID to get balance for (optional; defaults to first account)'),
  cutoff: z.string().optional().describe('Optional ISO date string cutoff'),
});

class ActualToolsManager {
  private tools: Map<string, ToolDefinition> = new Map();

  constructor() { }

  async initialize() {
    // Dynamically import all tool modules from src/tools/index.ts
    const toolModules = (await import('./tools/index.js')) as Record<string, unknown>;
    let count = 0;
    for (const [key, tool] of Object.entries(toolModules)) {
      const t = tool as unknown as { name?: string };
      if (t && t.name) {
        this.tools.set(t.name, tool as unknown as ToolDefinition);
        count++;
      }
    }
    logger.info(`🔗 Loaded ${count} tool modules from src/tools`);
  }

  /** Names of tools that are exposed directly via MCP (the meta/gateway tools). */
  static readonly META_TOOLS = ['actual_tool_registry', 'actual_tool_call'];

  /** Return names of ALL registered tools (internal + meta). */
  getToolNames(): string[] {
    return Array.from(this.tools.keys());
  }

  /** Return only the meta-tool names exposed via MCP's tools/list. */
  getExposedToolNames(): string[] {
    return ActualToolsManager.META_TOOLS.filter((n) => this.tools.has(n));
  }

  getTool(name: string): ToolDefinition | undefined {
    return this.tools.get(name);
  }

  async callTool(name: string, args: unknown): Promise<unknown> {
    const tool = this.getTool(name);
    if (!tool) throw new Error(`Tool not found: ${name}`);
    try {
      const callResult = await tool.call(args);
      if (callResult && typeof callResult === 'object' && 'content' in callResult) {
        const content = (callResult as { content?: unknown[] }).content;
        const count = Array.isArray(content) ? content.length : 0;
        logger.info(`[TOOL RESULT] ${name}: contentItems=${count}`);
      }

      // Invalidate cache entries after successful write operations
      if (isWriteTool(name)) {
        invalidateAfterWrite(name);
      }

      return callResult;
    } catch (err: unknown) {
      // Format Zod validation errors more clearly
      if (err && typeof err === 'object' && 'issues' in err) {
        const zodError = err as z.ZodError;
        const issues = zodError.issues.map(issue => {
          const path = issue.path.join('.');
          return `${path}: ${issue.message}`;
        }).join(', ');
        const formattedMsg = `Validation error: ${issues}`;
        logger.error(`[TOOL ERROR] ${name}: ${formattedMsg}`);
        throw new Error(formattedMsg);
      }

      const e = err as Error | { message?: unknown } | undefined;
      const msg = e && typeof e.message === 'string' ? e.message : String(err);
      logger.error(`[TOOL ERROR] ${name}: ${msg}`);
      throw err;
    }
  }

  /**
   * Get coverage statistics comparing implemented tools with available API methods
   */
  getCoverageStats() {
    const apiMethods = Object.keys(API_TOOL_MAP);
    const mappedTools = Object.values(API_TOOL_MAP);
    const implemented = IMPLEMENTED_TOOLS;

    const missing = mappedTools.filter(tool => !implemented.includes(tool));
    const coverage = (implemented.length / mappedTools.length) * 100;

    return {
      totalApiMethods: apiMethods.length,
      totalMappedTools: mappedTools.length,
      implementedTools: implemented.length,
      missingTools: missing.length,
      coveragePercent: Math.round(coverage * 100) / 100,
      missingToolsList: missing,
    };
  }

  /**
   * Get the API method name for a given tool name
   */
  getApiMethodForTool(toolName: string): string | undefined {
    return Object.entries(API_TOOL_MAP).find(([_, tool]) => tool === toolName)?.[0];
  }

  /**
   * Get the tool name for a given API method
   */
  getToolForApiMethod(apiMethod: string): string | undefined {
    return API_TOOL_MAP[apiMethod];
  }
}

export default new ActualToolsManager();
