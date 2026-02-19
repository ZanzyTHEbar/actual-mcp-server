/**
 * Shared retry-with-exponential-backoff utility for embedding providers.
 *
 * Handles transient network failures, rate limits (429), and server errors (5xx)
 * without permanently disabling the provider.
 */

import logger from '../../../logger.js';

export interface RetryOptions {
  maxRetries?: number;
  baseDelayMs?: number;
  maxDelayMs?: number;
  /** Only retry if this predicate returns true for the error. Default: retries on network/5xx/429 errors. */
  retryable?: (err: unknown) => boolean;
  label?: string;
}

const DEFAULT_MAX_RETRIES = 2;
const DEFAULT_BASE_DELAY_MS = 200;
const DEFAULT_MAX_DELAY_MS = 3000;

export function isRetryableError(err: unknown): boolean {
  if (!(err instanceof Error)) return false;

  const msg = err.message.toLowerCase();
  // Network errors
  if (msg.includes('econnrefused') || msg.includes('econnreset') || msg.includes('etimedout')
    || msg.includes('fetch failed') || msg.includes('socket hang up') || msg.includes('enotfound')) {
    return true;
  }

  // HTTP status-based
  const errObj = err as unknown as Record<string, unknown>;
  const status = typeof errObj.status === 'number' ? errObj.status
    : typeof errObj.statusCode === 'number' ? errObj.statusCode
      : (errObj.response && typeof (errObj.response as Record<string, unknown>).status === 'number')
        ? (errObj.response as Record<string, unknown>).status as number
        : undefined;
  if (status === 429 || (status !== undefined && status >= 500 && status < 600)) return true;

  return false;
}

export async function retryWithBackoff<T>(
  fn: () => Promise<T>,
  opts?: RetryOptions,
): Promise<T> {
  const maxRetries = opts?.maxRetries ?? DEFAULT_MAX_RETRIES;
  const baseDelay = opts?.baseDelayMs ?? DEFAULT_BASE_DELAY_MS;
  const maxDelay = opts?.maxDelayMs ?? DEFAULT_MAX_DELAY_MS;
  const isRetryable = opts?.retryable ?? isRetryableError;
  const label = opts?.label ?? 'retryWithBackoff';

  let lastErr: unknown;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      if (attempt >= maxRetries || !isRetryable(err)) {
        throw err;
      }
      const delay = Math.min(baseDelay * Math.pow(2, attempt), maxDelay);
      const jitter = Math.random() * delay * 0.3;
      logger.debug(
        `[${label}] Attempt ${attempt + 1}/${maxRetries + 1} failed, retrying in ${Math.round(delay + jitter)}ms: ${err instanceof Error ? err.message : err}`,
      );
      await sleep(delay + jitter);
    }
  }
  throw lastErr;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
