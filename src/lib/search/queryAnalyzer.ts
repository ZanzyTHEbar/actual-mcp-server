/**
 * Query analyzer — inspect query characteristics to auto-select the
 * optimal search mode and provide the HybridSearchEngine with hints.
 *
 * The analyzer is composable: it extracts ALL signals (amount, date, name,
 * natural language) from a single query simultaneously. The primary intent
 * is determined by the strongest signal, but extracted amounts and dates
 * are always returned for use as filters regardless of intent.
 */

import logger from '../../logger.js';

// ---------------------------------------------------------------------------
// Query classification
// ---------------------------------------------------------------------------

export type QueryIntent =
  | 'amount'
  | 'date'
  | 'exact_name'
  | 'natural'
  | 'filter_only';

export interface QueryAnalysis {
  intent: QueryIntent;
  recommendedMode: 'hybrid' | 'fulltext' | 'vector' | 'metadata' | null;
  ftsWeight: number;
  vecWeight: number;
  extractedAmounts?: { min?: number; max?: number };
  extractedDateHints?: string[];
  reason: string;
}

// ---------------------------------------------------------------------------
// Patterns
// ---------------------------------------------------------------------------

const AMOUNT_PATTERN = /\$\s*[\d,.]+|\d+\s*(dollars?|bucks|cents)|\b(over|under|above|below|more than|less than|between)\s+\$?\d/i;
const DATE_PATTERN = /\b(january|february|march|april|june|july|august|september|october|november|december|jan|feb|mar|apr|jun|jul|aug|sep|oct|nov|dec)\b|\b\d{4}[-/]\d{2}([-/]\d{2})?\b|\b(last|this|next)\s+(week|month|year|quarter)\b|\b(today|yesterday|recent|lately)\b/i;

// Matches: "Starbucks", "COSTCO WHOLESALE", "ATT*BILL PAYMENT", "Square Cash"
// Handles: Title Case, ALL CAPS, mixed with symbols/numbers
const EXACT_NAME_INDICATORS = /^[A-Z][\w*.\-']+(\s+[A-Z\d][\w*.\-']*){0,4}$/;

// ---------------------------------------------------------------------------
// Analyzer (composable — extracts all signals, picks primary intent)
// ---------------------------------------------------------------------------

export function analyzeQuery(
  text: string | undefined,
  hasFilters: boolean,
): QueryAnalysis {
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

  // Extract ALL signals composably (not exclusive)
  const hasAmount = AMOUNT_PATTERN.test(trimmed);
  const hasDate = DATE_PATTERN.test(trimmed);
  const looksLikeName = wordCount <= 3 && (EXACT_NAME_INDICATORS.test(trimmed) || wordCount === 1);

  const amounts = hasAmount ? extractAmounts(trimmed) : undefined;
  const dateHints = hasDate ? extractDateHints(trimmed) : undefined;

  // Determine primary intent by strongest signal
  // Priority: amount > date > exact_name > natural
  if (hasAmount) {
    return {
      intent: 'amount',
      recommendedMode: hasFilters ? 'metadata' : 'fulltext',
      ftsWeight: 1.2,
      vecWeight: 0.3,
      extractedAmounts: amounts,
      extractedDateHints: dateHints,
      reason: `Amount pattern detected: ${JSON.stringify(amounts)}`,
    };
  }

  if (hasDate) {
    return {
      intent: 'date',
      recommendedMode: null,
      ftsWeight: 1.0,
      vecWeight: 0.6,
      extractedAmounts: amounts,
      extractedDateHints: dateHints,
      reason: 'Date/temporal pattern detected',
    };
  }

  if (looksLikeName) {
    return {
      intent: 'exact_name',
      recommendedMode: null,
      ftsWeight: 1.5,
      vecWeight: 0.4,
      extractedAmounts: amounts,
      extractedDateHints: dateHints,
      reason: `Short/exact name query (${wordCount} words)`,
    };
  }

  return {
    intent: 'natural',
    recommendedMode: null,
    ftsWeight: 1.0,
    vecWeight: 0.8,
    extractedAmounts: amounts,
    extractedDateHints: dateHints,
    reason: `Natural language query (${wordCount} words)`,
  };
}

// ---------------------------------------------------------------------------
// Amount extraction — handles negative amounts (expenses are negative in Actual)
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
// Date hint extraction
// ---------------------------------------------------------------------------

function extractDateHints(text: string): string[] {
  const hints: string[] = [];
  const months = text.match(/\b(january|february|march|april|june|july|august|september|october|november|december|jan|feb|mar|apr|jun|jul|aug|sep|oct|nov|dec)\b/gi);
  if (months) hints.push(...months.map((m) => m.toLowerCase()));
  const relative = text.match(/\b(last|this|next)\s+(week|month|year|quarter)\b/gi);
  if (relative) hints.push(...relative.map((r) => r.toLowerCase()));
  const iso = text.match(/\b\d{4}[-/]\d{2}([-/]\d{2})?\b/g);
  if (iso) hints.push(...iso);
  return hints;
}

// ---------------------------------------------------------------------------
// Strip extracted patterns from query text before FTS
// ---------------------------------------------------------------------------

const AMOUNT_STRIP_PATTERNS = [
  /between\s+\$?[\d,.]+\s+and\s+\$?[\d,.]+/gi,
  /(over|above|more than|greater than|under|below|less than)\s+\$?[\d,.]+/gi,
  /\$[\d,.]+/g,
];

const DATE_STRIP_PATTERNS = [
  /\b(last|this|next)\s+(week|month|year|quarter)\b/gi,
  /\b\d{4}[-/]\d{2}([-/]\d{2})?\b/g,
];

/**
 * Strip extracted filter fragments (amounts, dates) from query text,
 * leaving only descriptive search terms for FTS5.
 */
export function stripExtractedPatterns(text: string): string {
  let result = text;
  for (const pat of AMOUNT_STRIP_PATTERNS) {
    result = result.replace(pat, ' ');
  }
  for (const pat of DATE_STRIP_PATTERNS) {
    result = result.replace(pat, ' ');
  }
  return result.replace(/\s+/g, ' ').trim();
}
