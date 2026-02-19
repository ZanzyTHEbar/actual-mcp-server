/**
 * Embedding codec — binary F32_BLOB serialization for libsql vector columns.
 *
 * Ported from picoclaw's Go implementation (pkg/memory/memory.go).
 * Wire format: little-endian IEEE 754 float32, 4 bytes per element.
 * Empty/null embeddings serialize as SQL NULL (not a 0-byte blob),
 * which is required for libsql's vector index to function correctly.
 *
 * For SQL query parameters, embeddings are formatted as JSON-like
 * string literals "[0.123, 0.456, ...]" and passed through vector32().
 */

/**
 * Serialize a float64 number[] to F32_BLOB binary (little-endian float32).
 * Returns null for empty arrays (maps to SQL NULL).
 */
export function embeddingToF32Blob(vec: number[]): Buffer | null {
  if (!vec || vec.length === 0) return null;
  const buf = Buffer.alloc(vec.length * 4);
  for (let i = 0; i < vec.length; i++) {
    buf.writeFloatLE(vec[i], i * 4);
  }
  return buf;
}

/**
 * Deserialize F32_BLOB binary to a float64 number[].
 * Returns null for empty/null input.
 */
export function f32BlobToEmbedding(blob: Buffer | Uint8Array | null): number[] | null {
  if (!blob || blob.length === 0) return null;
  const buf = Buffer.isBuffer(blob) ? blob : Buffer.from(blob);
  if (buf.length % 4 !== 0) {
    throw new Error(`F32_BLOB size ${buf.length} not a multiple of 4`);
  }
  const result = new Array<number>(buf.length / 4);
  for (let i = 0; i < result.length; i++) {
    result[i] = buf.readFloatLE(i * 4);
  }
  return result;
}

/**
 * Format an embedding as a vector string for libsql's vector32() function.
 * Output: "[0.123, 0.456, ...]"
 *
 * Used as a SQL parameter: `vector32(?)` where ? is this string.
 */
export function embeddingToVectorString(vec: number[]): string {
  if (!vec || vec.length === 0) return '[]';
  return '[' + vec.join(', ') + ']';
}

/** Validate embedding dimensions. Returns true if valid. */
export function validateDimensions(vec: number[] | null, expected: number): boolean {
  if (!vec) return false;
  return vec.length === expected;
}
