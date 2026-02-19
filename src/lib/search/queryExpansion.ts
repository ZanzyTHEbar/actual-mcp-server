/**
 * Query expansion for financial domain search.
 *
 * Maps common user terms to related synonyms/aliases so FTS5 MATCH queries
 * have better recall.  A user searching "groceries" will also match
 * "grocery", "supermarket", "food market", etc.
 *
 * The dictionary is bidirectional: every synonym in a group expands to
 * all other members.  Groups are maintained as arrays of related terms.
 *
 * This module is pure logic — no side effects, no imports.
 */

// ---------------------------------------------------------------------------
// Synonym groups — each array is a cluster of interchangeable terms
// ---------------------------------------------------------------------------

const SYNONYM_GROUPS: readonly string[][] = [
  // Food & groceries
  ['grocery', 'groceries', 'supermarket', 'food market', 'food store'],
  ['restaurant', 'dining', 'food', 'takeout', 'takeaway', 'dine-in', 'eatery'],
  ['coffee', 'cafe', 'café', 'coffeehouse', 'starbucks', 'espresso'],
  ['fast food', 'drive-thru', 'drive through', 'burger', 'pizza'],

  // Transportation
  ['gas', 'gasoline', 'fuel', 'petrol', 'gas station', 'filling station'],
  ['uber', 'lyft', 'taxi', 'cab', 'rideshare', 'ride share'],
  ['parking', 'garage', 'meter', 'valet'],
  ['auto', 'car', 'vehicle', 'automotive'],
  ['insurance', 'coverage', 'premium', 'policy'],

  // Housing
  ['rent', 'lease', 'rental', 'housing'],
  ['mortgage', 'home loan', 'house payment'],
  ['electricity', 'electric', 'power', 'energy'],
  ['water', 'sewer', 'water bill'],
  ['internet', 'wifi', 'broadband', 'isp'],

  // Shopping
  ['amazon', 'online shopping', 'online order'],
  ['clothing', 'clothes', 'apparel', 'fashion', 'garment'],
  ['electronics', 'tech', 'gadget', 'device'],

  // Health
  ['pharmacy', 'drugstore', 'medication', 'prescription', 'rx'],
  ['doctor', 'physician', 'medical', 'clinic', 'healthcare', 'health care'],
  ['dental', 'dentist', 'orthodontist'],
  ['gym', 'fitness', 'workout', 'exercise', 'health club'],

  // Finance
  ['subscription', 'recurring', 'membership', 'monthly'],
  ['transfer', 'wire', 'sent', 'payment'],
  ['atm', 'cash', 'withdrawal', 'cash back'],
  ['fee', 'charge', 'service charge', 'service fee'],
  ['interest', 'apr', 'finance charge'],
  ['refund', 'return', 'credit', 'reimbursement'],
  ['payroll', 'salary', 'wages', 'paycheck', 'direct deposit', 'income'],
  ['dividend', 'investment', 'stock', 'portfolio'],

  // Entertainment
  ['netflix', 'streaming', 'hulu', 'disney', 'hbo'],
  ['spotify', 'music', 'apple music', 'pandora'],
  ['movie', 'cinema', 'theater', 'theatre', 'film'],
  ['game', 'gaming', 'steam', 'playstation', 'xbox'],

  // Utilities & services
  ['phone', 'mobile', 'cell', 'cellular', 'wireless'],
  ['laundry', 'dry cleaning', 'dry cleaner', 'cleaners'],
  ['pet', 'veterinary', 'vet', 'animal'],

  // Travel
  ['hotel', 'motel', 'lodging', 'accommodation', 'airbnb'],
  ['flight', 'airline', 'airfare', 'plane ticket'],
  ['travel', 'trip', 'vacation', 'holiday'],
];

// ---------------------------------------------------------------------------
// Build reverse index: term → all synonyms in its group
// ---------------------------------------------------------------------------

const termToSynonyms = new Map<string, Set<string>>();

for (const group of SYNONYM_GROUPS) {
  const lowerGroup = group.map((t) => t.toLowerCase());
  const synonymSet = new Set(lowerGroup);
  for (const term of lowerGroup) {
    // Merge if term already belongs to another group
    const existing = termToSynonyms.get(term);
    if (existing) {
      for (const s of synonymSet) existing.add(s);
      // Update all members to point to the merged set
      for (const s of existing) termToSynonyms.set(s, existing);
    } else {
      termToSynonyms.set(term, synonymSet);
    }
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Terms with spaces or hyphens need quoting for FTS5 (hyphen = column prefix). */
function needsQuoting(term: string): boolean {
  return term.includes(' ') || term.includes('-');
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Expand a search query by adding synonyms from the financial dictionary.
 *
 * Tokenizes the query, looks up each token/bigram in the synonym map,
 * and returns the original query augmented with OR-joined alternatives.
 *
 * Example:
 *   expandQuery("groceries last month")
 *   → "groceries OR grocery OR supermarket OR \"food market\" OR \"food store\" last month"
 */
export function expandQuery(query: string): string {
  if (!query || query.trim().length === 0) return query;

  const lower = query.toLowerCase().trim();
  const words = lower.split(/\s+/);
  const expandedParts: string[] = [];
  const used = new Set<number>(); // track which word indices are consumed by bigrams

  // Check bigrams first (e.g. "fast food", "gas station")
  for (let i = 0; i < words.length - 1; i++) {
    if (used.has(i)) continue;
    const bigram = `${words[i]} ${words[i + 1]}`;
    const syns = termToSynonyms.get(bigram);
    if (syns && syns.size > 1) {
      const quotedBigram = `"${bigram}"`;
      const alternatives = [...syns]
        .filter((s) => s !== bigram)
        .map((s) => needsQuoting(s) ? `"${s}"` : s);
      expandedParts.push(`(${quotedBigram} OR ${alternatives.join(' OR ')})`);
      used.add(i);
      used.add(i + 1);
    }
  }

  // Check individual words
  for (let i = 0; i < words.length; i++) {
    if (used.has(i)) continue;
    const word = words[i];
    const syns = termToSynonyms.get(word);
    if (syns && syns.size > 1) {
      const alternatives = [...syns]
        .filter((s) => s !== word)
        .map((s) => needsQuoting(s) ? `"${s}"` : s);
      const quotedWord = needsQuoting(word) ? `"${word}"` : word;
      expandedParts.push(`(${quotedWord} OR ${alternatives.join(' OR ')})`);
    } else {
      expandedParts.push(word);
    }
  }

  return expandedParts.join(' ');
}

/**
 * Get all known synonyms for a term (for diagnostics / testing).
 */
export function getSynonyms(term: string): string[] {
  const syns = termToSynonyms.get(term.toLowerCase());
  return syns ? [...syns] : [];
}

/** Total number of synonym groups loaded. */
export const SYNONYM_GROUP_COUNT = SYNONYM_GROUPS.length;

/** Total number of unique terms in the dictionary. */
export const UNIQUE_TERM_COUNT = termToSynonyms.size;
