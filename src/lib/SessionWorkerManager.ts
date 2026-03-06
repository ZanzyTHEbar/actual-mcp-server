import { Worker } from 'worker_threads';
import path from 'path';
import fs from 'fs';
import { randomUUID } from 'crypto';
import logger from '../logger.js';
import config from '../config.js';
import { ensureCallToolResult, toTextResult } from './toolResult.js';
import { WriteCoordinator } from './WriteCoordinator.js';
import { requestContext } from './requestContext.js';
import { canAccessBudget, getAllowedBudgets } from '../auth/budget-acl.js';
import { normalizeToolName } from './toolNameNormalization.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import {
  listBudgetHandles,
  parseBudgetRegistry,
  resolveBudgetByName,
  toBudgetHandle,
  type BudgetConfig,
  type BudgetHandle,
} from './budget-registry.js';

type PendingRequest = {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
};

type IdentityLike = {
  userId: string;
  email?: string;
  groups?: string[];
};

type WorkerInfo = {
  worker: Worker;
  pending: Map<string, PendingRequest>;
  lastActivity: number;
  dataDir: string;
  activeBudget: BudgetHandle;
};

const DEFAULT_MAX_SESSIONS = 5;

function sanitizeSessionId(sessionId: string): string {
  return sessionId.replace(/[^a-zA-Z0-9_-]/g, '_');
}

function uniqueKeys(keys: string[]): string[] {
  const set = new Set(keys.filter(Boolean));
  return Array.from(set);
}

export class SessionWorkerManager {
  private workers = new Map<string, WorkerInfo>();
  private coordinator = new WriteCoordinator();
  private maxSessions: number;
  private baseDataDir: string;
  private toolCallTimeoutMs: number;
  private budgetRegistry: Map<string, BudgetConfig>;
  private searchBaseDir: string;

  constructor(opts?: { maxSessions?: number; baseDataDir?: string; toolCallTimeoutMs?: number }) {
    this.maxSessions = opts?.maxSessions ?? parseInt(process.env.MAX_CONCURRENT_SESSIONS || String(DEFAULT_MAX_SESSIONS), 10);
    this.baseDataDir = opts?.baseDataDir || config.MCP_BRIDGE_DATA_DIR || './actual-data';
    this.toolCallTimeoutMs = opts?.toolCallTimeoutMs ?? config.SESSION_TOOL_TIMEOUT_MS ?? 45_000;
    this.searchBaseDir = process.env.SEARCH_INDEX_DIR || path.join(this.baseDataDir, 'search-index');
    this.budgetRegistry = parseBudgetRegistry(process.env, {
      serverUrl: config.ACTUAL_SERVER_URL,
      password: config.ACTUAL_PASSWORD || '',
      syncId: config.ACTUAL_BUDGET_SYNC_ID,
      encryptionPassword: config.ACTUAL_BUDGET_PASSWORD,
    });
  }

  canAcceptNewSession(): boolean {
    return this.workers.size < this.maxSessions;
  }

  getStats() {
    const now = Date.now();
    return {
      maxConcurrent: this.maxSessions,
      activeSessions: this.workers.size,
      totalSessions: this.workers.size,
      sessions: Array.from(this.workers.entries()).map(([sessionId, info]) => ({
        sessionId,
        lastActivity: new Date(info.lastActivity),
        idleMinutes: Math.floor((now - info.lastActivity) / 60000),
        activeBudget: {
          name: info.activeBudget.name,
          syncId: info.activeBudget.syncId,
          budgetKey: info.activeBudget.budgetKey,
        },
      })),
    };
  }

  getBudgetRegistry(): BudgetHandle[] {
    return listBudgetHandles(this.budgetRegistry);
  }

  getSessionBudget(sessionId: string): BudgetHandle {
    const info = this.workers.get(sessionId);
    if (!info) {
      throw new Error(`Session ${sessionId} not initialized`);
    }
    return info.activeBudget;
  }

  private pickInitialBudget(identity?: IdentityLike): BudgetHandle {
    const budgets = this.getBudgetRegistry();
    if (!identity) {
      return budgets[0];
    }

    const allowed = getAllowedBudgets(identity);
    if (allowed === null || allowed.includes('*')) {
      return budgets[0];
    }

    const allowedSet = new Set(allowed);
    const match = budgets.find((budget) => allowedSet.has(budget.syncId));
    if (!match) {
      throw new Error(`Forbidden: user ${identity.userId} has no accessible configured budgets`);
    }
    return match;
  }

  listAvailableBudgets(identity?: IdentityLike, sessionId?: string) {
    const budgets = this.getBudgetRegistry()
      .filter((budget) => !identity || canAccessBudget(identity, budget.syncId))
      .map((budget) => ({
        name: budget.name,
        syncId: budget.syncId,
        serverUrl: budget.serverUrl,
        usesEncryption: Boolean(budget.encryptionPassword),
        budgetKey: budget.budgetKey,
        active: sessionId ? this.workers.get(sessionId)?.activeBudget.budgetKey === budget.budgetKey : false,
      }));
    return budgets;
  }

  getBudgetListResult(identity?: IdentityLike, sessionId?: string) {
    const budgets = this.listAvailableBudgets(identity, sessionId);
    return {
      budgets,
      count: budgets.length,
      hint: 'Pass a budget name to actual_budgets_switch to change the active budget for this session.',
    };
  }

  switchSessionBudget(
    sessionId: string,
    budgetName: string,
    identity?: IdentityLike,
  ): BudgetHandle {
    const info = this.workers.get(sessionId);
    if (!info) {
      throw new Error(`Session ${sessionId} not initialized`);
    }

    const { match, matches } = resolveBudgetByName(this.budgetRegistry, budgetName);
    if (!match) {
      if (matches.length > 1) {
        throw new Error(
          `Multiple budgets match "${budgetName}". Matching budgets: ${matches.map((budget) => budget.name).join(', ')}`,
        );
      }
      throw new Error(`No configured budget matched "${budgetName}"`);
    }

    if (identity && !canAccessBudget(identity, match.syncId)) {
      throw new Error(`Forbidden: you do not have access to budget "${match.name}"`);
    }

    info.activeBudget = match;
    logger.info(
      `[BudgetSwitch] Session ${sessionId} switched to "${match.name}" (${match.syncId}) on ${match.serverUrl}`,
    );
    return match;
  }

  getBudgetSwitchResult(
    sessionId: string,
    budgetName: string,
    identity?: IdentityLike,
  ) {
    const budget = this.switchSessionBudget(sessionId, budgetName, identity);
    return {
      success: true,
      budgetName: budget.name,
      budgetId: budget.syncId,
      budgetKey: budget.budgetKey,
      serverUrl: budget.serverUrl,
      message: `Switched to budget "${budget.name}" for session ${sessionId}`,
    };
  }

  async createSession(sessionId: string, identity?: IdentityLike): Promise<void> {
    if (this.workers.has(sessionId)) return;
    if (!this.canAcceptNewSession()) {
      throw new Error(`Max concurrent sessions (${this.maxSessions}) reached`);
    }

    const safeId = sanitizeSessionId(sessionId);
    const dataDir = path.join(this.baseDataDir, `session-${safeId}`);
    fs.mkdirSync(dataDir, { recursive: true });
    fs.mkdirSync(this.searchBaseDir, { recursive: true });
    const defaultBudget = this.pickInitialBudget(identity);

    const workerUrl = new URL('../workers/actualSessionWorker.js', import.meta.url);
    const worker = new Worker(workerUrl, {
      workerData: {
        sessionId,
        dataDir,
        searchBaseDir: this.searchBaseDir,
        initialBudget: defaultBudget,
      },
    });

    const pending = new Map<string, PendingRequest>();
    const info: WorkerInfo = {
      worker,
      pending,
      lastActivity: Date.now(),
      dataDir,
      activeBudget: defaultBudget,
    };
    this.workers.set(sessionId, info);

    worker.on('message', (message: any) => {
      if (!message || typeof message !== 'object') return;
      const { type, requestId, result, error } = message as { type?: string; requestId?: string; result?: unknown; error?: { message?: string; stack?: string } };
      if (!requestId) return;
      const pendingReq = pending.get(requestId);
      if (!pendingReq) return;
      pending.delete(requestId);
      if (type === 'toolError') {
        const err = new Error(error?.message || 'Worker tool error');
        if (error?.stack) err.stack = error.stack;
        pendingReq.reject(err);
        return;
      }
      pendingReq.resolve(result);
    });

    worker.on('error', (err) => {
      logger.error(`[Worker] Error for session ${sessionId}:`, err);
      this.rejectPendingRequests(
        sessionId,
        pending,
        `Worker errored for session ${sessionId}`,
        err,
      );
    });

    worker.on('exit', (code) => {
      logger.info(`[Worker] Session ${sessionId} exited with code ${code}`);
      this.rejectPendingRequests(
        sessionId,
        pending,
        `Worker exited for session ${sessionId} with code ${code}`,
      );
      this.workers.delete(sessionId);
    });
  }

  /** Update last activity timestamp for a session (e.g. on keepalive heartbeat). */
  touchSession(sessionId: string): void {
    const info = this.workers.get(sessionId);
    if (info) info.lastActivity = Date.now();
  }

  private rejectPendingRequests(
    sessionId: string,
    pending: Map<string, PendingRequest>,
    reason: string,
    cause?: unknown,
  ): void {
    if (pending.size === 0) return;
    const causeMsg = cause instanceof Error ? cause.message : (cause ? String(cause) : null);
    const message = causeMsg ? `${reason}: ${causeMsg}` : reason;

    for (const [requestId, req] of pending.entries()) {
      try {
        req.reject(new Error(`${message} (requestId=${requestId})`));
      } catch {
        // Best effort rejection for all pending requests
      }
    }
    pending.clear();
    logger.warn(`[Worker] Rejected pending requests for session ${sessionId}: ${message}`);
  }

  private broadcastSearchDirty(budget: BudgetHandle, originSessionId?: string): void {
    for (const [sessionId, info] of this.workers.entries()) {
      if (info.activeBudget.budgetKey !== budget.budgetKey) continue;
      if (originSessionId && sessionId === originSessionId) continue;
      try {
        info.worker.postMessage({ type: 'markSearchDirty', budgetKey: budget.budgetKey });
      } catch (err) {
        logger.warn(
          `[Worker] Failed to broadcast search dirty signal to session ${sessionId}: ${String(err)}`,
        );
      }
    }
  }

  async closeSession(sessionId: string): Promise<void> {
    const info = this.workers.get(sessionId);
    if (!info) return;
    this.rejectPendingRequests(sessionId, info.pending, `Session ${sessionId} is closing`);
    try {
      info.worker.postMessage({ type: 'shutdown' });
    } catch {
      // ignore
    }
    await info.worker.terminate();
    this.workers.delete(sessionId);
    if (config.MCP_SESSION_CACHE_CLEANUP) {
      try {
        if (info.dataDir && info.dataDir.includes('session-')) {
          fs.rmSync(info.dataDir, { recursive: true, force: true });
        }
      } catch (err) {
        logger.warn(`[Worker] Failed to clean data dir for session ${sessionId}: ${String(err)}`);
      }
    }
  }

  async executeTool(sessionId: string, toolName: string, args: unknown): Promise<CallToolResult> {
    const info = this.workers.get(sessionId);
    if (!info) throw new Error(`Session ${sessionId} not initialized`);
    info.lastActivity = Date.now();
    const canonicalToolName = normalizeToolName(toolName);
    const identity = requestContext.getStore()?.identity;
    const requestBudget = info.activeBudget;

    if (canonicalToolName === 'actual_budgets_list_available') {
      return toTextResult(this.getBudgetListResult(identity, sessionId));
    }

    if (canonicalToolName === 'actual_budgets_switch') {
      const budgetName = typeof (args as Record<string, unknown> | undefined)?.budgetName === 'string'
        ? (args as Record<string, unknown>).budgetName as string
        : '';
      if (!budgetName) {
        return toTextResult(
          { message: 'budgetName is required' },
          { isError: true },
        );
      }
      try {
        return toTextResult(this.getBudgetSwitchResult(sessionId, budgetName, identity));
      } catch (err) {
        return toTextResult(
          { message: err instanceof Error ? err.message : String(err) },
          { isError: true },
        );
      }
    }

    // Budget ACL enforcement: when identity exists, deny if user lacks budget access
    if (identity) {
      const budgetSyncId = requestBudget.syncId;
      if (!canAccessBudget(identity, budgetSyncId)) {
        logger.warn(`[ACL] Access denied: user=${identity.userId} budget=${budgetSyncId}`);
        return toTextResult(
          { message: 'Forbidden: you do not have access to this budget' },
          { isError: true }
        );
      }
    }

    const isWrite = this.isWriteTool(canonicalToolName);
    const keys = isWrite ? uniqueKeys(this.getWriteKeys(requestBudget, canonicalToolName, args)) : [];
    const release = isWrite ? await this.coordinator.acquire(keys) : null;

    try {
      const requestId = randomUUID();
      const resultPromise = new Promise<unknown>((resolve, reject) => {
        const timeout = setTimeout(() => {
          if (!info.pending.has(requestId)) return;
          info.pending.delete(requestId);
          reject(new Error(
            `Tool "${canonicalToolName}" timed out after ${this.toolCallTimeoutMs}ms`,
          ));
        }, this.toolCallTimeoutMs);

        info.pending.set(requestId, {
          resolve: (value) => {
            clearTimeout(timeout);
            resolve(value);
          },
          reject: (error) => {
            clearTimeout(timeout);
            reject(error);
          },
        });
      });

      try {
        info.worker.postMessage({
          type: 'executeTool',
          requestId,
          toolName: canonicalToolName,
          args,
          budget: requestBudget,
        });
      } catch (err) {
        const pendingReq = info.pending.get(requestId);
        if (pendingReq) {
          info.pending.delete(requestId);
          const sendErr = err instanceof Error ? err : new Error(String(err));
          pendingReq.reject(sendErr);
        }
      }
      try {
        const result = await resultPromise;
        const callResult = ensureCallToolResult(result);
        if (isWrite && !callResult.isError) {
          this.broadcastSearchDirty(requestBudget, sessionId);
        }
        return callResult;
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        if (msg.includes('timed out')) {
          logger.warn(`[Worker] ${msg} (session=${sessionId})`);
          return toTextResult(
            {
              message: msg,
              sessionId,
              toolName: canonicalToolName,
              timeoutMs: this.toolCallTimeoutMs,
            },
            { isError: true },
          );
        }
        throw err;
      }
    } finally {
      if (release) release();
    }
  }

  private isWriteTool(toolName: string): boolean {
    return WRITE_TOOLS.has(toolName);
  }

  private getWriteKeys(budget: BudgetHandle, toolName: string, args: unknown): string[] {
    const a = (args || {}) as Record<string, unknown>;
    const keys: string[] = [];
    const budgetPrefix = `budget:${budget.budgetKey}`;

    const add = (prefix: string, value?: unknown) => {
      if (typeof value === 'string' && value.length > 0) keys.push(`${budgetPrefix}:${prefix}:${value}`);
    };

    if (toolName === 'actual_budget_updates_batch') {
      const ops = Array.isArray(a.operations) ? a.operations : [];
      for (const op of ops) {
        const catId = (op as Record<string, unknown>)?.categoryId;
        add('category', catId);
      }
      if (keys.length === 0) keys.push(`${budgetPrefix}:budget:batch`);
      return keys;
    }

    if (toolName === 'actual_transactions_create' || toolName === 'actual_transactions_import') {
      add('account', a.accountId || a.account);
      return keys.length ? keys : [`${budgetPrefix}:transactions:create`];
    }
    if (toolName === 'actual_transactions_update' || toolName === 'actual_transactions_delete') {
      add('transaction', a.id);
      return keys.length ? keys : [`${budgetPrefix}:transactions:update`];
    }
    if (toolName === 'actual_transactions_update_batch') {
      const updates = Array.isArray(a.updates) ? a.updates : [];
      for (const u of updates) {
        add('transaction', (u as Record<string, unknown>)?.id);
      }
      return keys.length ? keys : [`${budgetPrefix}:transactions:batch_update`];
    }

    if (toolName === 'actual_accounts_create') return [`${budgetPrefix}:account:create`];
    if (toolName.startsWith('actual_accounts_')) {
      add('account', a.id);
      return keys.length ? keys : [`${budgetPrefix}:account:update`];
    }

    if (toolName.startsWith('actual_categories_')) {
      add('category', a.id || a.categoryId);
      add('category_group', a.group_id || a.groupId);
      return keys.length ? keys : [`${budgetPrefix}:category:update`];
    }
    if (toolName.startsWith('actual_category_groups_')) {
      add('category_group', a.id);
      return keys.length ? keys : [`${budgetPrefix}:category_group:update`];
    }

    if (toolName.startsWith('actual_payees_')) {
      add('payee', a.id || a.targetId);
      const mergeIds = Array.isArray(a.mergeIds) ? a.mergeIds : [];
      for (const id of mergeIds) add('payee', id);
      return keys.length ? keys : [`${budgetPrefix}:payee:update`];
    }

    if (toolName.startsWith('actual_rules_')) {
      add('rule', a.id);
      return keys.length ? keys : [`${budgetPrefix}:rule:update`];
    }

    if (toolName.startsWith('actual_budgets_')) {
      add('category', a.categoryId || a.fromCategoryId);
      add('category', a.toCategoryId);
      return keys.length ? keys : [`${budgetPrefix}:budget:update`];
    }

    if (toolName === 'actual_bank_sync') {
      add('account', a.accountId);
      return keys.length ? keys : [`${budgetPrefix}:bank_sync:all`];
    }

    return [`${budgetPrefix}:write:unknown`];
  }
}

const WRITE_TOOLS = new Set([
  'actual_accounts_create',
  'actual_accounts_update',
  'actual_accounts_delete',
  'actual_accounts_close',
  'actual_accounts_reopen',
  'actual_transactions_create',
  'actual_transactions_update',
  'actual_transactions_update_batch',
  'actual_transactions_delete',
  'actual_transactions_import',
  'actual_categories_create',
  'actual_categories_update',
  'actual_categories_delete',
  'actual_category_groups_create',
  'actual_category_groups_update',
  'actual_category_groups_delete',
  'actual_payees_create',
  'actual_payees_update',
  'actual_payees_delete',
  'actual_payees_merge',
  'actual_rules_create',
  'actual_rules_create_or_update',
  'actual_rules_update',
  'actual_rules_delete',
  'actual_budgets_setAmount',
  'actual_budgets_transfer',
  'actual_budgets_setCarryover',
  'actual_budgets_holdForNextMonth',
  'actual_budgets_resetHold',
  'actual_budget_updates_batch',
  'actual_bank_sync',
]);

export const sessionWorkerManager = new SessionWorkerManager();
