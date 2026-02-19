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

import type { EmbeddingProvider, EmbeddingProviderInfo } from './types.js';
import logger from '../../../logger.js';

const DEFAULT_MODEL = 'text-embedding-3-small';
const DEFAULT_DIMENSIONS = 1536;

export class OpenAICompatibleProvider implements EmbeddingProvider {
  readonly providerId = 'openai-compatible';
  readonly modelId: string;
  readonly dimensions: number;

  private _client: any = null;
  private _available = false;
  private _failed = false;
  private _baseUrl: string;
  private _apiKey: string;

  constructor(opts?: {
    model?: string;
    dimensions?: number;
    apiKey?: string;
    baseUrl?: string;
  }) {
    this.modelId = opts?.model ?? DEFAULT_MODEL;
    this.dimensions = opts?.dimensions ?? DEFAULT_DIMENSIONS;
    this._apiKey = opts?.apiKey ?? '';
    this._baseUrl = opts?.baseUrl ?? 'https://api.openai.com';
  }

  async init(): Promise<boolean> {
    if (this._available) return true;
    if (this._failed) return false;

    try {
      const { default: OpenAI } = await import('openai');

      this._client = new OpenAI({
        apiKey: this._apiKey || 'no-key', // Some local servers don't need a key
        baseURL: this._baseUrl.endsWith('/v1')
          ? this._baseUrl
          : `${this._baseUrl}/v1`,
      });

      // Lightweight health check: create a small embedding
      const test = await this._client.embeddings.create({
        model: this.modelId,
        input: 'health check',
        ...(this.dimensions && this.modelId.includes('text-embedding-3')
          ? { dimensions: this.dimensions }
          : {}),
      });

      if (!test.data?.[0]?.embedding) {
        throw new Error('Empty embedding response from health check');
      }

      // Auto-detect dimensions from response if not explicitly set
      const actualDims = test.data[0].embedding.length;
      if (actualDims !== this.dimensions) {
        logger.info(
          `[OpenAI] Auto-detected dimensions=${actualDims} (config said ${this.dimensions})`,
        );
        (this as any).dimensions = actualDims;
      }

      this._available = true;
      logger.info(
        `[OpenAI] Connected to ${this._baseUrl}, model="${this.modelId}", dims=${this.dimensions}`,
      );
      return true;
    } catch (err) {
      this._failed = true;
      logger.warn(
        `[OpenAI] Failed to connect to ${this._baseUrl}. ` +
        `Error: ${err instanceof Error ? err.message : err}`,
      );
      return false;
    }
  }

  isAvailable(): boolean {
    return this._available && !this._failed;
  }

  async embed(text: string): Promise<number[] | null> {
    if (!this.isAvailable() && !(await this.init())) return null;

    try {
      const response = await this._client.embeddings.create({
        model: this.modelId,
        input: text,
        ...(this.dimensions && this.modelId.includes('text-embedding-3')
          ? { dimensions: this.dimensions }
          : {}),
      });

      const vec = response.data?.[0]?.embedding;
      if (!vec || !Array.isArray(vec)) {
        logger.warn('[OpenAI] Empty embedding response');
        return null;
      }
      return vec;
    } catch (err) {
      logger.warn(`[OpenAI] embed() failed: ${err instanceof Error ? err.message : err}`);
      return null;
    }
  }

  async embedBatch(texts: string[]): Promise<(number[] | null)[]> {
    if (!this.isAvailable() && !(await this.init())) return texts.map(() => null);
    if (texts.length === 0) return [];

    try {
      // OpenAI supports batch via input array (up to 2048 items)
      const response = await this._client.embeddings.create({
        model: this.modelId,
        input: texts,
        ...(this.dimensions && this.modelId.includes('text-embedding-3')
          ? { dimensions: this.dimensions }
          : {}),
      });

      const data = response.data;
      if (!Array.isArray(data)) return texts.map(() => null);

      // Response items are indexed by `index` field
      const result: (number[] | null)[] = new Array(texts.length).fill(null);
      for (const item of data) {
        if (item.index !== undefined && item.embedding) {
          result[item.index] = item.embedding;
        }
      }
      return result;
    } catch (err) {
      logger.warn(`[OpenAI] embedBatch() failed: ${err instanceof Error ? err.message : err}`);
      // Fallback to sequential
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
        baseUrl: this._baseUrl,
        hasApiKey: Boolean(this._apiKey),
        failed: this._failed,
      },
    };
  }
}
