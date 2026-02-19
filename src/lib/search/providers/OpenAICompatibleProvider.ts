/**
 * OpenAICompatibleProvider — embedding provider for any server implementing
 * the OpenAI /v1/embeddings API.
 *
 * Works with: OpenAI, Azure OpenAI, vLLM, LiteLLM, text-embeddings-inference,
 * Anyscale, Together AI, Fireworks, and any other OpenAI-compatible endpoint.
 *
 * Uses the official `openai` npm package which handles retries, streaming,
 * auth, and error formatting out of the box.
 *
 * Env vars:
 *   OPENAI_API_KEY (required for OpenAI; optional for local servers)
 *   OPENAI_BASE_URL (default: https://api.openai.com)
 *   EMBEDDING_MODEL (default: text-embedding-3-small)
 */

import type OpenAI from 'openai';
import type { EmbeddingProvider, EmbeddingProviderInfo } from './types.js';
import { retryWithBackoff } from './retry.js';
import logger from '../../../logger.js';

interface EmbeddingCreateResponse {
  data: { embedding: number[]; index: number }[];
  model: string;
  usage: { prompt_tokens: number; total_tokens: number };
}

const DEFAULT_MODEL = 'text-embedding-3-small';
const DEFAULT_DIMENSIONS = 1536;

export class OpenAICompatibleProvider implements EmbeddingProvider {
  readonly providerId = 'openai-compatible';
  readonly modelId: string;

  /**
   * Dimension count. Starts at configured value, but may be updated
   * at runtime via auto-detection from the first real embedding response.
   */
  private _dimensions: number;
  get dimensions(): number { return this._dimensions; }

  private _client: OpenAI | null = null;
  private _available = false;
  private _consecutiveFailures = 0;
  private _baseUrl: string;
  private _apiKey: string;
  private _dimAutoDetected = false;

  constructor(opts?: {
    model?: string;
    dimensions?: number;
    apiKey?: string;
    baseUrl?: string;
  }) {
    this.modelId = opts?.model ?? DEFAULT_MODEL;
    this._dimensions = opts?.dimensions ?? DEFAULT_DIMENSIONS;
    this._apiKey = opts?.apiKey ?? '';
    this._baseUrl = opts?.baseUrl ?? 'https://api.openai.com';
  }

  async init(): Promise<boolean> {
    if (this._available) return true;

    try {
      const { default: OpenAIClient } = await import('openai');

      this._client = new OpenAIClient({
        apiKey: this._apiKey || 'no-key',
        baseURL: this._baseUrl.endsWith('/v1')
          ? this._baseUrl
          : `${this._baseUrl}/v1`,
      });

      // For paid endpoints (api.openai.com), skip the test embedding to save cost.
      // Dimension auto-detection will happen on the first real embed() call.
      const isPaid = this._baseUrl.includes('api.openai.com');
      if (!isPaid) {
        const test = await retryWithBackoff<EmbeddingCreateResponse>(
          () => this._client!.embeddings.create({
            model: this.modelId,
            input: 'health check',
            ...this.dimensionParams(),
          }),
          { maxRetries: 2, label: 'OpenAI.init' },
        );

        if (!test.data?.[0]?.embedding) {
          throw new Error('Empty embedding response from health check');
        }

        const actualDims = test.data[0].embedding.length;
        if (actualDims !== this._dimensions) {
          logger.info(`[OpenAI] Auto-detected dimensions=${actualDims} (config said ${this._dimensions})`);
          this._dimensions = actualDims;
          this._dimAutoDetected = true;
        }
      }

      this._available = true;
      this._consecutiveFailures = 0;
      logger.info(
        `[OpenAI] Ready: ${this._baseUrl}, model="${this.modelId}", dims=${this._dimensions}` +
        (isPaid ? ' (skipped test embed to save cost)' : ''),
      );
      return true;
    } catch (err) {
      this._consecutiveFailures++;
      logger.warn(
        `[OpenAI] Failed to connect to ${this._baseUrl}. ` +
        `Error: ${err instanceof Error ? err.message : err}`,
      );
      return false;
    }
  }

  isAvailable(): boolean {
    return this._available;
  }

  private dimensionParams(): Record<string, number> | Record<string, never> {
    if (this._dimensions && this.modelId.includes('text-embedding-3')) {
      return { dimensions: this._dimensions };
    }
    return {};
  }

  async embed(text: string): Promise<number[] | null> {
    if (!this.isAvailable() && !(await this.init())) return null;

    try {
      const response = await retryWithBackoff<EmbeddingCreateResponse>(
        () => this._client!.embeddings.create({
          model: this.modelId,
          input: text,
          ...this.dimensionParams(),
        }),
        { maxRetries: 2, label: 'OpenAI.embed' },
      );

      const vec = response.data?.[0]?.embedding;
      if (!vec || !Array.isArray(vec)) {
        logger.warn('[OpenAI] Empty embedding response');
        return null;
      }

      if (!this._dimAutoDetected && vec.length !== this._dimensions) {
        logger.info(`[OpenAI] Auto-detected dimensions=${vec.length} from first embed call`);
        this._dimensions = vec.length;
        this._dimAutoDetected = true;
      }

      this._consecutiveFailures = 0;
      return vec;
    } catch (err) {
      this._consecutiveFailures++;
      if (this._consecutiveFailures >= 3) {
        this._available = false;
        logger.warn(`[OpenAI] ${this._consecutiveFailures} consecutive failures — marking unavailable`);
      }
      logger.warn(`[OpenAI] embed() failed: ${err instanceof Error ? err.message : err}`);
      return null;
    }
  }

  async embedBatch(texts: string[]): Promise<(number[] | null)[]> {
    if (!this.isAvailable() && !(await this.init())) return texts.map(() => null);
    if (texts.length === 0) return [];

    try {
      const response = await retryWithBackoff<EmbeddingCreateResponse>(
        () => this._client!.embeddings.create({
          model: this.modelId,
          input: texts,
          ...this.dimensionParams(),
        }),
        { maxRetries: 2, label: 'OpenAI.embedBatch' },
      );

      const data = response.data;
      if (!Array.isArray(data)) return texts.map(() => null);

      const result: (number[] | null)[] = new Array(texts.length).fill(null);
      for (const item of data) {
        if (item.index !== undefined && item.embedding) {
          result[item.index] = item.embedding;
        }
      }
      this._consecutiveFailures = 0;
      return result;
    } catch (err) {
      logger.warn(`[OpenAI] embedBatch() failed, falling back to sequential: ${err instanceof Error ? err.message : err}`);
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
      dimensions: this._dimensions,
      available: this.isAvailable(),
      meta: {
        baseUrl: this._baseUrl,
        hasApiKey: Boolean(this._apiKey),
        consecutiveFailures: this._consecutiveFailures,
        dimAutoDetected: this._dimAutoDetected,
      },
    };
  }
}
