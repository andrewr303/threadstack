import type { CollectionRecord } from './schema.js';
import { trigramSimilarity } from './search.js';

const UNFILED = 'Unfiled / Uncertain';

export function normalizeName(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

export const GENERIC_NAME_TOKENS = new Set(['general', 'research', 'personal', 'misc', 'other', 'unfiled', 'uncertain', 'notes', 'project', 'projects', 'work', 'app', 'web', 'api', 'main', 'test']);

/** Find an existing project matching a provider project / repo / AI-suggested name. */
export function findMatchingProject(
  name: string,
  collections: CollectionRecord[]
): CollectionRecord | null {
  const target = normalizeName(name);
  if (!target) return null;
  const usable = collections.filter((c) => c.name !== UNFILED);
  const exact = usable.find((c) => normalizeName(c.name) === target);
  if (exact) return exact;
  const targetTokens = target.split(' ').filter((t) => !GENERIC_NAME_TOKENS.has(t) && t.length >= 3);
  for (const c of usable) {
    const nameTokens = normalizeName(c.name).split(' ');
    const distinctive = nameTokens.filter((t) => !GENERIC_NAME_TOKENS.has(t) && t.length >= 4);
    if (distinctive.length > 0 && targetTokens.some((t) => distinctive.includes(t))) return c;
    const keywords = (c.keywords ?? []).map(normalizeName).filter(Boolean);
    if (keywords.some((k) => k === target || targetTokens.includes(k) || (k.length >= 5 && target.includes(k)))) {
      return c;
    }
  }
  let best: CollectionRecord | null = null;
  let bestSim = 0;
  for (const c of usable) {
    const sim = trigramSimilarity(normalizeName(c.name), target);
    if (sim > bestSim) {
      bestSim = sim;
      best = c;
    }
  }
  return bestSim >= 0.72 ? best : null;
}

