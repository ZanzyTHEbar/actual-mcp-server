/**
 * HuggingFaceLocalProvider — wraps the existing EmbeddingPipeline as an
 * EmbeddingProvider implementation.  Runs inference locally via
 * @huggingface/transformers (ONNX runtime, CPU or WebGPU).
 *
 * This is the default provider — zero external deps, works offline
 * after the first model download.
 */

import type { EmbeddingProvider, EmbeddingProviderInfo } from './types.js';
import logger from '../../../logger.js';

const DEFAULT_MODEL = 'Xenova/all-MiniLM-L6-v2';
const DEFAULT_DIMENSIONS = 384;

export class HuggingFaceLocalProvider implements EmbeddingProvider {
  readonly providerId = 'huggingface-local';
  readonly modelId: string;
  readonly dimensions: number;

  private _pipeline: any = null;
  private _loading: Promise<boolean> | null = null;
  private _failed = false;
  private _quantized: boolean;

  constructor(opts?: { model?: string; dimensions?: number; quantized?: boolean }) {
    this.modelId = opts?.model ?? DEFAULT_MODEL;
    this.dimensions = opts?.dimensions ?? DEFAULT_DIMENSIONS;
    this._quantized = opts?.quantized ?? true;
  }

  async init(): Promise<boolean> {
    if (this._pipeline) return true;
    if (this._failed) return false;
    if (this._loading) return this._loading;

    this._loading = (async () => {
      const startMs = Date.now();
      logger.info(`[HFLocal] Loading model "${this.modelId}" (quantized=${this._quantized})…`);

      try {
        const { pipeline, env } = await import('@huggingface/transformers');
        env.allowRemoteModels = true;

        this._pipeline = await pipeline('feature-extraction', this.modelId, {
          dtype: this._quantized ? 'q8' : 'fp32',
        });

        logger.info(`[HFLocal] Model ready in ${Date.now() - startMs}ms (dims=${this.dimensions})`);
        return true;
      } catch (err) {
        this._failed = true;
        logger.warn(
          `[HFLocal] Failed to load model "${this.modelId}". ` +
          `Error: ${err instanceof Error ? err.message : err}`,
        );
        return false;
      } finally {
        this._loading = null;
      }
    })();

    return this._loading;
  }

  isAvailable(): boolean {
    return this._pipeline !== null && !this._failed;
  }

  async embed(text: string): Promise<number[] | null> {
    if (!this.isAvailable() && !(await this.init())) return null;

    try {
      const output = await this._pipeline(text, {
        pooling: 'mean',
        normalize: true,
      });
      const arr: number[] = Array.from(output.data as Float32Array);
      if (arr.length !== this.dimensions) {
        logger.warn(`[HFLocal] Dimension mismatch: expected ${this.dimensions}, got ${arr.length}`);
      }
      return arr;
    } catch (err) {
      logger.warn(`[HFLocal] embed() failed: ${err instanceof Error ? err.message : err}`);
      return null;
    }
  }

  async embedBatch(texts: string[]): Promise<(number[] | null)[]> {
    if (!this.isAvailable() && !(await this.init())) return texts.map(() => null);
    const results: (number[] | null)[] = [];
    for (const t of texts) {
      results.push(await this.embed(t));
    }
    return results;
  }

  getInfo(): EmbeddingProviderInfo {
    return {
      provider: this.providerId,
      model: this.modelId,
      dimensions: this.dimensions,
      available: this.isAvailable(),
      meta: { quantized: this._quantized, failed: this._failed },
    };
  }
}
