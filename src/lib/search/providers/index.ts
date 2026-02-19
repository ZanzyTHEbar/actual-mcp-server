/**
 * Embedding providers barrel export.
 */

export type { EmbeddingProvider, EmbeddingProviderInfo, EmbeddingProviderConfig } from './types.js';
export { HuggingFaceLocalProvider } from './HuggingFaceLocalProvider.js';
export { OllamaProvider } from './OllamaProvider.js';
export { OpenAICompatibleProvider } from './OpenAICompatibleProvider.js';
export { createEmbeddingProvider } from './factory.js';
