import {
  getCachedAccounts,
  getCachedCategories,
  getCachedPayees,
  getCachedSchedules,
} from './cachedRefs.js';

export type LookupEntityType = 'accounts' | 'schedules' | 'categories' | 'payees';

interface NamedEntity {
  id?: string;
  name?: string | null;
}

export interface LookupMatch {
  id: string;
  name: string;
}

export type LookupByNameResult =
  | { status: 'found'; match: LookupMatch }
  | { status: 'not_found'; available: string[] }
  | { status: 'ambiguous'; matches: LookupMatch[] };

function normalizeName(value: string): string {
  return value.trim().toLocaleLowerCase();
}

function toLookupMatch(entity: NamedEntity): LookupMatch | null {
  if (!entity.id || !entity.name) return null;
  return { id: entity.id, name: entity.name };
}

async function listEntities(type: LookupEntityType): Promise<NamedEntity[]> {
  switch (type) {
    case 'accounts':
      return getCachedAccounts();
    case 'categories':
      return getCachedCategories();
    case 'payees':
      return getCachedPayees();
    case 'schedules':
      return getCachedSchedules();
    default:
      return [];
  }
}

export async function lookupEntityByName(
  type: LookupEntityType,
  name: string,
): Promise<LookupByNameResult> {
  const normalizedTarget = normalizeName(name);
  const entities = await listEntities(type);

  const exactMatches = entities
    .filter((entity) => typeof entity.name === 'string')
    .filter((entity) => normalizeName(entity.name!) === normalizedTarget)
    .map(toLookupMatch)
    .filter((entity): entity is LookupMatch => entity !== null);

  if (exactMatches.length === 1) {
    return { status: 'found', match: exactMatches[0] };
  }

  if (exactMatches.length > 1) {
    return { status: 'ambiguous', matches: exactMatches };
  }

  const available = entities
    .map((entity) => entity.name)
    .filter((entity): entity is string => typeof entity === 'string' && entity.length > 0)
    .sort((a, b) => a.localeCompare(b));

  return { status: 'not_found', available };
}
