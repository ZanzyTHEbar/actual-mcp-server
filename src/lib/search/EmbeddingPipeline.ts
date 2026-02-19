/**
 * EmbeddingPipeline — thin wrapper around @huggingface/transformers that
 * lazily loads a small sentence-embedding model and produces float32 vectors.
 *
 * Default model: Xenova/all-MiniLM-L6-v2  (384-dim, ~23 MB quantised)
 * The model is downloaded on first use and cached in the HF cache dir.
 *
 * This module is designed to be used from worker threads.  The heavy model
 * load happens once per worker lifetime, and subsequent embed() calls are
 * fast (~5-15 ms per sentence on CPU).
 */

import logger from '../../logger.js';

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

const DEFAULT_MODEL = 'Xenova/all-MiniLM-L6-v2';
const DEFAULT_DIMENSIONS = 384;
const DEFAULT_QUANTIZED = true; // Use INT8 quantised weights

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface EmbeddingPipelineOptions {
  /** HuggingFace model id (default: Xenova/all-MiniLM-L6-v2). */
  model?: string;
  /** Expected output dimensions (default: 384). */
  dimensions?: number;
  /** Use quantised weights for smaller footprint (default: true). */
  quantized?: boolean;
}

// ---------------------------------------------------------------------------
// Pipeline singleton
// ---------------------------------------------------------------------------

interface FeatureExtractionPipeline {
  (input: string | string[], opts?: { pooling?: string; normalize?: boolean }): Promise<{ data: Float32Array }>;
}

let _pipeline: FeatureExtractionPipeline | null = null;
let _loading: Promise<void> | null = null;
let _modelId: string = DEFAULT_MODEL;
let _dimensions: number = DEFAULT_DIMENSIONS;
let _loadFailed = false;

/**
 * Ensure the model is loaded.  Safe to call multiple times — only the first
 * call triggers the download / load; subsequent calls await the same promise.
 */
async function ensureLoaded(opts?: EmbeddingPipelineOptions): Promise<boolean> {
  if (_pipeline) return true;
  if (_loadFailed) return false;
  if (_loading) {
    await _loading;
    return _pipeline !== null;
  }

  _modelId = opts?.model ?? DEFAULT_MODEL;
  _dimensions = opts?.dimensions ?? DEFAULT_DIMENSIONS;
  const quantized = opts?.quantized ?? DEFAULT_QUANTIZED;

  _loading = (async () => {
    const startMs = Date.now();
    logger.info(`[Embedding] Loading model "${_modelId}" (quantized=${quantized})…`);

    try {
      // Dynamic import so the module tree doesn't break if the package
      // is missing (e.g. in test environments).
      const { pipeline, env } = await import('@huggingface/transformers');

      // Disable remote model fetching warnings in CI / Docker
      env.allowRemoteModels = true;

      _pipeline = await pipeline('feature-extraction', _modelId, {
        dtype: quantized ? 'q8' : 'fp32',
      }) as unknown as FeatureExtractionPipeline;

      logger.info(
        `[Embedding] Model ready in ${Date.now() - startMs}ms (dims=${_dimensions})`,
      );
    } catch (err) {
      _loading = null;
      _loadFailed = true;
      logger.warn(
        `[Embedding] Failed to load model "${_modelId}". ` +
        `Semantic search will be unavailable. Error: ${err instanceof Error ? err.message : err}`,
      );
      // Do NOT rethrow — graceful degradation
    }
  })();

  await _loading;
  return _pipeline !== null;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Generate a float32 embedding for a single text string.
 * Returns a plain number[] of length `dimensions`.
 */
export async function embed(
  text: string,
  opts?: EmbeddingPipelineOptions,
): Promise<number[] | null> {
  const loaded = await ensureLoaded(opts);
  if (!loaded) return null;

  const output = await _pipeline!(text, {
    pooling: 'mean',
    normalize: true,
  });

  const arr: number[] = Array.from(output.data);

  // Sanity-check dimensions
  if (arr.length !== _dimensions) {
    logger.warn(
      `[Embedding] Dimension mismatch: expected ${_dimensions}, got ${arr.length}`,
    );
  }

  return arr;
}

/**
 * Batch-embed multiple texts.  Texts are processed individually to avoid
 * OOM on large batches — the MiniLM model is fast enough that the overhead
 * is negligible for typical budget-data volumes.
 */
export async function embedBatch(
  texts: string[],
  opts?: EmbeddingPipelineOptions,
): Promise<(number[] | null)[]> {
  const loaded = await ensureLoaded(opts);
  if (!loaded) return texts.map(() => null);
  const results: (number[] | null)[] = [];
  for (const t of texts) {
    results.push(await embed(t, opts));
  }
  return results;
}

/**
 * Build a searchable text representation for a transaction so that
 * semantic search captures the financial context.
 */
export function buildTransactionText(tx: {
  payee_name: string;
  category_name: string;
  account_name: string;
  notes: string;
  amount: number;
  date: string;
}): string {
  const parts: string[] = [];
  if (tx.payee_name) parts.push(tx.payee_name);
  if (tx.category_name) parts.push(tx.category_name);
  if (tx.account_name) parts.push(tx.account_name);
  if (tx.notes) parts.push(tx.notes);
  // Include human-readable amount for context
  const dollars = (Math.abs(tx.amount) / 100).toFixed(2);
  const sign = tx.amount < 0 ? 'expense' : 'income';
  parts.push(`${sign} $${dollars}`);
  if (tx.date) parts.push(tx.date);
  return parts.join(' | ');
}

/** Returns true if the embedding model is loaded and functional. */
export function isAvailable(): boolean {
  return _pipeline !== null && !_loadFailed;
}

/** Metadata about the loaded model. */
export function getModelInfo() {
  return {
    model: _modelId,
    dimensions: _dimensions,
    loaded: _pipeline !== null,
    failed: _loadFailed,
  };
}
