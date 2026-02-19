/**
 * OllamaProvider — embedding provider backed by a running Ollama instance.
 *
 * Uses the official `ollama` npm package for type-safe, battle-tested
 * communication with the Ollama API.
 *
 * Default model: all-minilm (384-dim).  Any model that supports
 * `ollama.embed()` works — nomic-embed-text, mxbai-embed-large, etc.
 *
 * Env vars:
 *   OLLAMA_HOST (default: http://localhost)
 *   OLLAMA_PORT (default: 11434)
 *   EMBEDDING_MODEL (default: all-minilm)
 */

import type { EmbeddingProvider, EmbeddingProviderInfo } from './types.js';
import logger from '../../../logger.js';

const DEFAULT_MODEL = 'all-minilm';
const DEFAULT_DIMENSIONS = 384;

export class OllamaProvider implements EmbeddingProvider {
  readonly providerId = 'ollama';
  readonly modelId: string;
  readonly dimensions: number;

  private _client: any = null;
  private _available = false;
  private _failed = false;
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
    if (this._failed) return false;

    try {
      const { Ollama } = await import('ollama');
      const baseUrl = `${this._host}:${this._port}`;
      this._client = new Ollama({ host: baseUrl });

      // Health check: list models to verify connectivity
      const models = await this._client.list();
      const hasModel = models.models?.some(
        (m: any) => m.name === this.modelId || m.name.startsWith(`${this.modelId}:`),
      );

      if (!hasModel) {
        logger.warn(
          `[Ollama] Model "${this.modelId}" not found locally. ` +
          `Available: ${models.models?.map((m: any) => m.name).join(', ') || 'none'}. ` +
          `Run: ollama pull ${this.modelId}`,
        );
        // Don't fail — Ollama will auto-pull on first embed() in some configs
      }

      this._available = true;
      logger.info(`[Ollama] Connected to ${baseUrl}, model="${this.modelId}"`);
      return true;
    } catch (err) {
      this._failed = true;
      logger.warn(
        `[Ollama] Failed to connect. Is Ollama running? ` +
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
      const response = await this._client.embed({
        model: this.modelId,
        input: text,
      });

      // ollama.embed returns { embeddings: number[][] }
      const vec = response.embeddings?.[0];
      if (!vec || !Array.isArray(vec)) {
        logger.warn('[Ollama] Empty embedding response');
        return null;
      }
      return vec;
    } catch (err) {
      logger.warn(`[Ollama] embed() failed: ${err instanceof Error ? err.message : err}`);
      return null;
    }
  }

  async embedBatch(texts: string[]): Promise<(number[] | null)[]> {
    if (!this.isAvailable() && !(await this.init())) return texts.map(() => null);

    try {
      // Ollama supports batch via input array
      const response = await this._client.embed({
        model: this.modelId,
        input: texts,
      });

      const embeddings = response.embeddings;
      if (!Array.isArray(embeddings)) return texts.map(() => null);

      return texts.map((_: string, i: number) => embeddings[i] ?? null);
    } catch (err) {
      logger.warn(`[Ollama] embedBatch() failed: ${err instanceof Error ? err.message : err}`);
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
        host: `${this._host}:${this._port}`,
        failed: this._failed,
      },
    };
  }
}
