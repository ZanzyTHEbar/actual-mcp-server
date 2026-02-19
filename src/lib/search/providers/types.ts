/**
 * EmbeddingProvider — contract that all embedding backends must implement.
 *
 * Providers are selected at startup via the EMBEDDING_PROVIDER env var
 * and injected into SearchIndex / HybridSearchEngine via the factory.
 */

export interface EmbeddingProvider {
  /** Provider identifier for logging / diagnostics. */
  readonly providerId: string;

  /** Model identifier (provider-specific). */
  readonly modelId: string;

  /** Output vector dimensionality. */
  readonly dimensions: number;

  /**
   * Initialise the provider (download model, check health, etc.).
   * Returns true if the provider is ready; false on failure.
   * Must be idempotent — safe to call multiple times.
   */
  init(): Promise<boolean>;

  /** Whether the provider is initialised and functional. */
  isAvailable(): boolean;

  /**
   * Embed a single text string.
   * Returns null if the provider is unavailable or the call fails.
   */
  embed(text: string): Promise<number[] | null>;

  /**
   * Embed multiple texts.
   * Default: sequential calls to embed(). Providers may override
   * with native batch endpoints for better throughput.
   */
  embedBatch(texts: string[]): Promise<(number[] | null)[]>;

  /** Diagnostic info for the index-info tool. */
  getInfo(): EmbeddingProviderInfo;
}

export interface EmbeddingProviderInfo {
  provider: string;
  model: string;
  dimensions: number;
  available: boolean;
  /** Provider-specific metadata (e.g. endpoint URL, quantization). */
  meta?: Record<string, unknown>;
}

/**
 * Config consumed by the provider factory.
 * Mirrors the env vars from config.ts.
 */
export interface EmbeddingProviderConfig {
  provider: 'local' | 'ollama' | 'openai';
  model?: string;
  dimensions?: number;
  // HuggingFace local
  hfModel?: string;
  hfQuantized?: boolean;
  // Ollama
  ollamaHost?: string;
  ollamaPort?: string;
  // OpenAI-compatible
  openaiApiKey?: string;
  openaiBaseUrl?: string;
}
