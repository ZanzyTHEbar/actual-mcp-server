/**
 * HuggingFaceLocalProvider — wraps the @huggingface/transformers pipeline as an
 * EmbeddingProvider implementation.  Runs inference locally via ONNX runtime
 * (CPU or WebGPU).
 *
 * This is the default provider — zero external deps, works offline
 * after the first model download.
 *
 * The pipeline accepts an array of strings for batch embedding, which we
 * leverage in embedBatch() for better throughput than sequential calls.
 */

import type { EmbeddingProvider, EmbeddingProviderInfo } from './types.js';
import logger from '../../../logger.js';

/** Minimal callable type for a feature-extraction pipeline from @huggingface/transformers. */
interface FeatureExtractionPipeline {
  (input: string | string[], opts?: { pooling?: string; normalize?: boolean }): Promise<{ data: Float32Array }>;
}

const DEFAULT_MODEL = 'Xenova/all-MiniLM-L6-v2';
const DEFAULT_DIMENSIONS = 384;
const BATCH_CHUNK_SIZE = 32;

export class HuggingFaceLocalProvider implements EmbeddingProvider {
  readonly providerId = 'huggingface-local';
  readonly modelId: string;
  readonly dimensions: number;

  private _pipeline: FeatureExtractionPipeline | null = null;
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
      logger.info(`[HFLocal] Loading model "${this.modelId}" (quantized=${this._quantized})...`);

      try {
        const { pipeline, env } = await import('@huggingface/transformers');
        env.allowRemoteModels = true;

        this._pipeline = await pipeline('feature-extraction', this.modelId, {
          dtype: this._quantized ? 'q8' : 'fp32',
        }) as unknown as FeatureExtractionPipeline;

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
      const output = await this._pipeline!(text, {
        pooling: 'mean',
        normalize: true,
      });
      const arr: number[] = Array.from(output.data);
      if (arr.length !== this.dimensions) {
        logger.warn(`[HFLocal] Dimension mismatch: expected ${this.dimensions}, got ${arr.length}`);
      }
      return arr;
    } catch (err) {
      logger.warn(`[HFLocal] embed() failed: ${err instanceof Error ? err.message : err}`);
      return null;
    }
  }

  /**
   * Batch embedding using the pipeline's native array input support.
   * Processes in chunks of BATCH_CHUNK_SIZE to bound memory usage.
   */
  async embedBatch(texts: string[]): Promise<(number[] | null)[]> {
    if (!this.isAvailable() && !(await this.init())) return texts.map(() => null);
    if (texts.length === 0) return [];

    // Single text — no need for batch overhead
    if (texts.length === 1) {
      const vec = await this.embed(texts[0]);
      return [vec];
    }

    const allResults: (number[] | null)[] = new Array(texts.length).fill(null);

    for (let start = 0; start < texts.length; start += BATCH_CHUNK_SIZE) {
      const chunk = texts.slice(start, start + BATCH_CHUNK_SIZE);
      try {
        const output = await this._pipeline!(chunk, {
          pooling: 'mean',
          normalize: true,
        });

        const data = output.data;
        const dims = this.dimensions;
        for (let i = 0; i < chunk.length; i++) {
          const offset = i * dims;
          allResults[start + i] = Array.from(data.slice(offset, offset + dims));
        }
      } catch (err) {
        logger.warn(
          `[HFLocal] Batch chunk failed (offset=${start}, size=${chunk.length}), falling back to sequential: ` +
          `${err instanceof Error ? err.message : err}`,
        );
        for (let i = 0; i < chunk.length; i++) {
          allResults[start + i] = await this.embed(chunk[i]);
        }
      }
    }

    return allResults;
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
