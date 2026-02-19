/**
 * Embedding provider factory.
 *
 * Reads config from environment (via config.ts), instantiates the
 * appropriate provider, and provides a fallback chain:
 *   configured provider → HuggingFace local → null (search disabled)
 *
 * Usage:
 *   const provider = await createEmbeddingProvider();
 *   if (provider) {
 *     const vec = await provider.embed('hello');
 *   }
 */

import type { EmbeddingProvider, EmbeddingProviderConfig } from './types.js';
import { HuggingFaceLocalProvider } from './HuggingFaceLocalProvider.js';
import { OllamaProvider } from './OllamaProvider.js';
import { OpenAICompatibleProvider } from './OpenAICompatibleProvider.js';
import logger from '../../../logger.js';

// ---------------------------------------------------------------------------
// Config extraction
// ---------------------------------------------------------------------------

function getProviderConfig(): EmbeddingProviderConfig {
  return {
    provider: (process.env.EMBEDDING_PROVIDER as 'local' | 'ollama' | 'openai') ?? 'local',
    model: process.env.EMBEDDING_MODEL,
    dimensions: process.env.EMBEDDING_DIMENSIONS
      ? parseInt(process.env.EMBEDDING_DIMENSIONS, 10)
      : undefined,
    hfModel: process.env.SEARCH_EMBEDDING_MODEL,
    hfQuantized: true,
    ollamaHost: process.env.OLLAMA_HOST,
    ollamaPort: process.env.OLLAMA_PORT,
    openaiApiKey: process.env.OPENAI_API_KEY,
    openaiBaseUrl: process.env.OPENAI_BASE_URL,
  };
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

function buildProvider(cfg: EmbeddingProviderConfig): EmbeddingProvider {
  switch (cfg.provider) {
    case 'ollama':
      return new OllamaProvider({
        model: cfg.model ?? 'all-minilm',
        dimensions: cfg.dimensions ?? 384,
        host: cfg.ollamaHost,
        port: cfg.ollamaPort,
      });

    case 'openai':
      return new OpenAICompatibleProvider({
        model: cfg.model ?? 'text-embedding-3-small',
        dimensions: cfg.dimensions ?? 1536,
        apiKey: cfg.openaiApiKey,
        baseUrl: cfg.openaiBaseUrl,
      });

    case 'local':
    default:
      return new HuggingFaceLocalProvider({
        model: cfg.model ?? cfg.hfModel,
        dimensions: cfg.dimensions ?? 384,
        quantized: cfg.hfQuantized,
      });
  }
}

// ---------------------------------------------------------------------------
// Singleton management
// ---------------------------------------------------------------------------

let _singleton: EmbeddingProvider | null = null;
let _singletonInit: Promise<EmbeddingProvider | null> | null = null;

/**
 * Get or create the singleton embedding provider.
 *
 * Fallback chain:
 *   1. Configured provider (from EMBEDDING_PROVIDER env var)
 *   2. HuggingFace local (if configured provider isn't 'local' and failed)
 *   3. null (all providers failed — search will operate in FTS-only mode)
 *
 * The result is cached: subsequent calls return the same instance.
 */
export async function createEmbeddingProvider(): Promise<EmbeddingProvider | null> {
  if (_singleton) return _singleton;
  if (_singletonInit) return _singletonInit;

  _singletonInit = initProvider();
  _singleton = await _singletonInit;
  _singletonInit = null;
  return _singleton;
}

async function initProvider(): Promise<EmbeddingProvider | null> {
  const cfg = getProviderConfig();
  logger.info(`[EmbeddingFactory] Creating provider: ${cfg.provider}`);

  const primary = buildProvider(cfg);
  const ok = await primary.init();
  if (ok) {
    logger.info(
      `[EmbeddingFactory] Provider "${primary.providerId}" ready ` +
      `(model=${primary.modelId}, dims=${primary.dimensions})`,
    );
    return primary;
  }

  // Fallback to local if the configured provider isn't already local
  if (cfg.provider !== 'local') {
    logger.warn(
      `[EmbeddingFactory] Primary provider "${cfg.provider}" failed. ` +
      `Falling back to HuggingFace local.`,
    );
    // Use the expected dimensions from the local model, not from the failed primary
    const fallback = new HuggingFaceLocalProvider({
      model: cfg.hfModel,
      dimensions: 384, // all-MiniLM-L6-v2 always produces 384-dim
      quantized: cfg.hfQuantized,
    });
    const fallbackOk = await fallback.init();
    if (fallbackOk) {
      logger.info(`[EmbeddingFactory] Fallback provider "huggingface-local" ready`);
      return fallback;
    }
  }

  logger.warn('[EmbeddingFactory] All providers failed. Vector search will be unavailable.');
  return null;
}

/**
 * Get the current singleton (or null if not yet initialized).
 * Does NOT trigger initialization — use createEmbeddingProvider() for that.
 */
export function getEmbeddingProvider(): EmbeddingProvider | null {
  return _singleton;
}

/** Reset singleton (for testing only). */
export function _resetProviderSingleton(): void {
  _singleton = null;
  _singletonInit = null;
}

/** Expose provider classes for direct instantiation in tests. */
export { HuggingFaceLocalProvider, OllamaProvider, OpenAICompatibleProvider };
