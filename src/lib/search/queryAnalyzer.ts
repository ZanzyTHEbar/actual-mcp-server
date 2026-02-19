/**
 * Query analyzer — inspect query characteristics to auto-select the
 * optimal search mode and provide the HybridSearchEngine with hints.
 *
 * The analyzer classifies queries into categories:
 *   - amount queries: contain dollar amounts or numbers → metadata mode
 *   - date queries: contain date patterns → metadata + FTS
 *   - exact name queries: short, look like a payee name → FTS-heavy
 *   - natural language: longer, descriptive → hybrid (vector + FTS)
 *   - filter-only: no text at all → metadata mode
 */

import logger from '../../logger.js';

// ---------------------------------------------------------------------------
// Query classification
// ---------------------------------------------------------------------------

export type QueryIntent =
  | 'amount'          // "$50", "over 100", "between 20 and 50"
  | 'date'            // "last month", "january", "2025-01"
  | 'exact_name'      // "Starbucks", "Amazon Prime"
  | 'natural'         // "coffee shops near downtown"
  | 'filter_only';    // no text, just metadata filters

export interface QueryAnalysis {
  intent: QueryIntent;
  /** Recommended search mode override (null = use whatever the user specified). */
  recommendedMode: 'hybrid' | 'fulltext' | 'vector' | 'metadata' | null;
  /** Suggested FTS weight adjustment (1.0 = default). */
  ftsWeight: number;
  /** Suggested vector weight adjustment (0.8 = default). */
  vecWeight: number;
  /** Extracted amount range (if detected). */
  extractedAmounts?: { min?: number; max?: number };
  /** Extracted date hints (if detected). */
  extractedDateHints?: string[];
  /** Diagnostic reason for classification. */
  reason: string;
}

// ---------------------------------------------------------------------------
// Patterns
// ---------------------------------------------------------------------------

const AMOUNT_PATTERN = /\$\s*[\d,.]+|\d+\s*(dollars?|bucks|cents)|\b(over|under|above|below|more than|less than|between)\s+\$?\d/i;
const DATE_PATTERN = /\b(january|february|march|april|may|june|july|august|september|october|november|december|jan|feb|mar|apr|jun|jul|aug|sep|oct|nov|dec)\b|\b\d{4}[-/]\d{2}([-/]\d{2})?\b|\b(last|this|next)\s+(week|month|year|quarter)\b|\b(today|yesterday|recent|lately)\b/i;
const EXACT_NAME_INDICATORS = /^[A-Z][a-z]+(\s+[A-Z][a-z]+){0,3}$/; // "Starbucks", "Whole Foods"

// ---------------------------------------------------------------------------
// Analyzer
// ---------------------------------------------------------------------------

export function analyzeQuery(
  text: string | undefined,
  hasFilters: boolean,
): QueryAnalysis {
  // No text at all → pure filter mode
  if (!text || text.trim().length === 0) {
    return {
      intent: 'filter_only',
      recommendedMode: hasFilters ? 'metadata' : null,
      ftsWeight: 1.0,
      vecWeight: 0.8,
      reason: 'No query text provided',
    };
  }

  const trimmed = text.trim();
  const wordCount = trimmed.split(/\s+/).length;

  // Check for amount patterns
  if (AMOUNT_PATTERN.test(trimmed)) {
    const amounts = extractAmounts(trimmed);
    return {
      intent: 'amount',
      recommendedMode: hasFilters ? 'metadata' : 'fulltext',
      ftsWeight: 1.2,
      vecWeight: 0.3, // Amount queries benefit little from semantic search
      extractedAmounts: amounts,
      reason: `Amount pattern detected: ${JSON.stringify(amounts)}`,
    };
  }

  // Check for date patterns
  if (DATE_PATTERN.test(trimmed)) {
    return {
      intent: 'date',
      recommendedMode: null, // Let hybrid handle it — both FTS and vector help here
      ftsWeight: 1.0,
      vecWeight: 0.6,
      extractedDateHints: extractDateHints(trimmed),
      reason: 'Date/temporal pattern detected',
    };
  }

  // Short queries that look like entity names → FTS-heavy
  if (wordCount <= 3 && (EXACT_NAME_INDICATORS.test(trimmed) || wordCount === 1)) {
    return {
      intent: 'exact_name',
      recommendedMode: null, // Keep hybrid but boost FTS
      ftsWeight: 1.5,
      vecWeight: 0.4,
      reason: `Short/exact name query (${wordCount} words)`,
    };
  }

  // Default: natural language → full hybrid
  return {
    intent: 'natural',
    recommendedMode: null,
    ftsWeight: 1.0,
    vecWeight: 0.8,
    reason: `Natural language query (${wordCount} words)`,
  };
}

// ---------------------------------------------------------------------------
// Amount extraction helpers
// ---------------------------------------------------------------------------

function extractAmounts(text: string): { min?: number; max?: number } {
  const result: { min?: number; max?: number } = {};

  // "between X and Y"
  const between = text.match(/between\s+\$?([\d,.]+)\s+and\s+\$?([\d,.]+)/i);
  if (between) {
    result.min = parseFloat(between[1].replace(/,/g, '')) * 100;
    result.max = parseFloat(between[2].replace(/,/g, '')) * 100;
    return result;
  }

  // "over/above/more than X"
  const over = text.match(/(over|above|more than|greater than)\s+\$?([\d,.]+)/i);
  if (over) {
    result.min = parseFloat(over[2].replace(/,/g, '')) * 100;
    return result;
  }

  // "under/below/less than X"
  const under = text.match(/(under|below|less than)\s+\$?([\d,.]+)/i);
  if (under) {
    result.max = parseFloat(under[2].replace(/,/g, '')) * 100;
    return result;
  }

  // Bare "$X"
  const bare = text.match(/\$([\d,.]+)/);
  if (bare) {
    const val = parseFloat(bare[1].replace(/,/g, '')) * 100;
    result.min = val;
    result.max = val;
  }

  return result;
}

// ---------------------------------------------------------------------------
// Date hint extraction (for diagnostics, not parsing)
// ---------------------------------------------------------------------------

function extractDateHints(text: string): string[] {
  const hints: string[] = [];
  const months = text.match(/\b(january|february|march|april|may|june|july|august|september|october|november|december|jan|feb|mar|apr|jun|jul|aug|sep|oct|nov|dec)\b/gi);
  if (months) hints.push(...months.map((m) => m.toLowerCase()));
  const relative = text.match(/\b(last|this|next)\s+(week|month|year|quarter)\b/gi);
  if (relative) hints.push(...relative.map((r) => r.toLowerCase()));
  const iso = text.match(/\b\d{4}[-/]\d{2}([-/]\d{2})?\b/g);
  if (iso) hints.push(...iso);
  return hints;
}
