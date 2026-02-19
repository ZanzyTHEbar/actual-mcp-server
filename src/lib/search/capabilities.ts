/**
 * Database capability detection — probes libsql/SQLite at startup to
 * determine which features are available.
 *
 * Ported from picoclaw (pkg/memory/delegate/capabilities.go).
 *
 * libsql extends SQLite with vector functions, but these may not be
 * available in all environments (e.g. plain better-sqlite3, older builds).
 * FTS5 is an SQLite compile-time extension that may also be absent.
 *
 * The search engine reads these flags to select appropriate fallback
 * strategies instead of crashing on unsupported SQL syntax.
 */

import type { DatabaseInstance } from './types.js';
import logger from '../../logger.js';

export interface DbCapabilities {
  fts5: boolean;
  vectorDistanceCos: boolean;
  vectorTopK: boolean;
  vector32: boolean;
}

/**
 * Probe the database to detect which extensions are available.
 * Each probe is wrapped in try/catch — a failed probe means the
 * feature is not available.
 */
export function detectCapabilities(db: DatabaseInstance): DbCapabilities {
  const caps: DbCapabilities = {
    fts5: false,
    vectorDistanceCos: false,
    vectorTopK: false,
    vector32: false,
  };

  caps.fts5 = probeFTS5(db);
  caps.vector32 = probeVector32(db);
  caps.vectorDistanceCos = probeVectorDistanceCos(db);
  caps.vectorTopK = probeVectorTopK(db);

  logger.info(
    `[Capabilities] FTS5=${caps.fts5}, vector32=${caps.vector32}, ` +
    `vectorDistanceCos=${caps.vectorDistanceCos}, vectorTopK=${caps.vectorTopK}`,
  );

  return caps;
}

function probeFTS5(db: DatabaseInstance): boolean {
  try {
    db.exec('CREATE VIRTUAL TABLE IF NOT EXISTS _cap_fts_probe USING fts5(content)');
    db.exec('DROP TABLE IF EXISTS _cap_fts_probe');
    return true;
  } catch {
    return false;
  }
}

function probeVector32(db: DatabaseInstance): boolean {
  try {
    const row = db.prepare("SELECT typeof(vector32('[1.0, 2.0]')) AS t").get() as { t: string } | undefined;
    return row?.t === 'blob';
  } catch {
    return false;
  }
}

function probeVectorDistanceCos(db: DatabaseInstance): boolean {
  try {
    db.prepare("SELECT vector_distance_cos(vector32('[1.0, 0.0]'), vector32('[0.0, 1.0]'))").get();
    return true;
  } catch {
    return false;
  }
}

function probeVectorTopK(db: DatabaseInstance): boolean {
  try {
    // vector_top_k requires an actual index — just check if the function is recognized
    // by trying to prepare a statement. It will fail with "no such index" rather than
    // "no such function" if the function exists.
    db.prepare("SELECT * FROM vector_top_k('_nonexistent_idx', vector32('[1.0]'), 1)").get();
    return true;
  } catch (err) {
    if (err instanceof Error) {
      // "no such index" means the function exists but the index doesn't — feature is available
      if (err.message.includes('no such index') || err.message.includes('not found')) {
        return true;
      }
    }
    return false;
  }
}
