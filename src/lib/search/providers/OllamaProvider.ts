/**
 * OllamaProvider — embedding provider backed by a running Ollama instance.
 *
 * Uses the official `ollama` npm package for type-safe communication.
 *
 * Default model: all-minilm (384-dim). Any model that supports
 * `ollama.embed()` works — nomic-embed-text, mxbai-embed-large, etc.
 *
 * Env vars:
 *   OLLAMA_HOST (default: http://localhost)
 *   OLLAMA_PORT (default: 11434)
 *   EMBEDDING_MODEL (default: all-minilm)
 */

import type { Ollama, EmbedResponse, ListResponse } from 'ollama';
import type { EmbeddingProvider, EmbeddingProviderInfo } from './types.js';
import { retryWithBackoff } from './retry.js';
import logger from '../../../logger.js';

const DEFAULT_MODEL = 'all-minilm';
const DEFAULT_DIMENSIONS = 384;
const HEALTH_CHECK_INTERVAL_MS = 60_000;

export class OllamaProvider implements EmbeddingProvider {
  readonly providerId = 'ollama';
  readonly modelId: string;
  readonly dimensions: number;

  private _client: Ollama | null = null;
  private _available = false;
  private _consecutiveFailures = 0;
  private _lastHealthCheck = 0;
  private _host: string;
  private _port: string;

  constructor(opts?: {
    model?: string;
    dimensions?: number;
    host?: string;
    port?: string;
  }) {
    this.modelId = opts?.model ?? DEFAULT_MODEL;
    this.dimensions = opts?.dimensions ?? DEFAULT_DIMENSIONS;
    this._host = opts?.host ?? 'http://localhost';
    this._port = opts?.port ?? '11434';
  }

  async init(): Promise<boolean> {
    if (this._available) return true;

    try {
      const { Ollama: OllamaClient } = await import('ollama');
      const baseUrl = `${this._host}:${this._port}`;
      this._client = new OllamaClient({ host: baseUrl });

      await this.healthCheck();
      return this._available;
    } catch (err) {
      this._consecutiveFailures++;
      logger.warn(
        `[Ollama] Failed to connect. Is Ollama running? ` +
        `Error: ${err instanceof Error ? err.message : err}`,
      );
      return false;
    }
  }

  async healthCheck(): Promise<boolean> {
    if (!this._client) return false;

    try {
      const models: ListResponse = await this._client.list();
      const hasModel = models.models?.some(
        (m) => m.name === this.modelId || m.name.startsWith(`${this.modelId}:`),
      );

      if (!hasModel) {
        logger.warn(
          `[Ollama] Model "${this.modelId}" not found locally. ` +
          `Available: ${models.models?.map((m) => m.name).join(', ') || 'none'}. ` +
          `Run: ollama pull ${this.modelId}`,
        );
      }

      this._available = true;
      this._consecutiveFailures = 0;
      this._lastHealthCheck = Date.now();
      logger.info(`[Ollama] Health check passed (${this._host}:${this._port})`);
      return true;
    } catch (err) {
      this._available = false;
      this._consecutiveFailures++;
      logger.warn(
        `[Ollama] Health check failed (attempt ${this._consecutiveFailures}): ` +
        `${err instanceof Error ? err.message : err}`,
      );
      return false;
    }
  }

  isAvailable(): boolean {
    return this._available;
  }

  private shouldRecheck(): boolean {
    if (this._available) return false;
    if (this._consecutiveFailures >= 10) return false;
    return Date.now() - this._lastHealthCheck > HEALTH_CHECK_INTERVAL_MS;
  }

  async embed(text: string): Promise<number[] | null> {
    if (!this.isAvailable()) {
      if (this.shouldRecheck()) await this.healthCheck();
      if (!this.isAvailable() && !(await this.init())) return null;
    }

    try {
      const response = await retryWithBackoff<EmbedResponse>(
        () => this._client!.embed({ model: this.modelId, input: text }),
        { maxRetries: 2, label: 'Ollama.embed' },
      );

      const vec = response.embeddings?.[0];
      if (!vec || !Array.isArray(vec)) {
        logger.warn('[Ollama] Empty embedding response');
        return null;
      }
      this._consecutiveFailures = 0;
      return vec;
    } catch (err) {
      this._consecutiveFailures++;
      if (this._consecutiveFailures >= 3) {
        this._available = false;
        logger.warn(`[Ollama] ${this._consecutiveFailures} consecutive failures — marking unavailable`);
      }
      logger.warn(`[Ollama] embed() failed: ${err instanceof Error ? err.message : err}`);
      return null;
    }
  }

  async embedBatch(texts: string[]): Promise<(number[] | null)[]> {
    if (!this.isAvailable() && !(await this.init())) return texts.map(() => null);

    try {
      const response = await retryWithBackoff<EmbedResponse>(
        () => this._client!.embed({ model: this.modelId, input: texts }),
        { maxRetries: 2, label: 'Ollama.embedBatch' },
      );

      const embeddings = response.embeddings;
      if (!Array.isArray(embeddings)) return texts.map(() => null);

      this._consecutiveFailures = 0;
      return texts.map((_, i) => embeddings[i] ?? null);
    } catch (err) {
      logger.warn(`[Ollama] embedBatch() failed, falling back to sequential: ${err instanceof Error ? err.message : err}`);
      const results: (number[] | null)[] = [];
      for (const t of texts) {
        results.push(await this.embed(t));
      }
      return results;
    }
  }

  getInfo(): EmbeddingProviderInfo {
    return {
      provider: this.providerId,
      model: this.modelId,
      dimensions: this.dimensions,
      available: this.isAvailable(),
      meta: {
        host: `${this._host}:${this._port}`,
        consecutiveFailures: this._consecutiveFailures,
      },
    };
  }
}
