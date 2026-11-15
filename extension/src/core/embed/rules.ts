// The declarativeNetRequest session rule that lets provider pages load inside Threadkeeper's
// workspace tab, and the bookkeeping of which rule id belongs to which tab.
//
// Accepted trade-off: declarativeNetRequest can only remove a whole response header, not edit
// one directive of it. Without X-Frame-Options and CSP frame-ancestors every provider refuses
// to be framed (measured in a real-Chromium spike), so documents loaded as sub-frames of a
// workspace tab also lose the rest of their Content-Security-Policy (script-src and friends).
// The rule is limited to sub-frame documents inside Threadkeeper's own manager tab (tabIds is
// only available to session rules, which also vanish when the browser restarts) and never
// touches ordinary tabs, top-level documents or any other resource type. Frames are sandboxed
// by the workspace page so an embedded page cannot navigate Threadkeeper away.
//
// Pure: the chrome API is passed in, so the rule shape and id handling are unit-tested.

/** Headers removed from sub-frame responses inside a workspace tab. */
export const EMBED_STRIPPED_HEADERS = ['x-frame-options', 'content-security-policy', 'content-security-policy-report-only'] as const;

/** Session rule ids this module owns. Other session rules (none today) must stay outside. */
export const EMBED_RULE_ID_MIN = 1000;
export const EMBED_RULE_ID_MAX = 1999;

export interface EmbedRule {
  id: number;
  priority: 1;
  action: {
    type: 'modifyHeaders';
    responseHeaders: Array<{ header: string; operation: 'remove' }>;
  };
  condition: { tabIds: number[]; resourceTypes: ['sub_frame']; excludedRequestDomains?: string[] };
}

/** The slice of chrome.declarativeNetRequest used here. */
export interface SessionRulesApi {
  getSessionRules(): Promise<Array<{ id: number; condition?: { tabIds?: number[] } }>>;
  updateSessionRules(options: { removeRuleIds?: number[]; addRules?: EmbedRule[] }): Promise<void>;
}

export function isEmbedRuleId(id: number): boolean {
  return Number.isInteger(id) && id >= EMBED_RULE_ID_MIN && id <= EMBED_RULE_ID_MAX;
}

export function embedRule(ruleId: number, tabId: number, protectedDomains: string[] = []): EmbedRule {
  return {
    id: ruleId,
    priority: 1,
    action: {
      type: 'modifyHeaders',
      responseHeaders: EMBED_STRIPPED_HEADERS.map((header) => ({ header, operation: 'remove' as const })),
    },
    condition: {
      tabIds: [tabId], resourceTypes: ['sub_frame'],
      ...(protectedDomains.length ? { excludedRequestDomains: [...new Set(protectedDomains)].sort() } : {}),
    },
  };
}

/** Lowest free id in the owned range, or null when every id is taken. */
export function allocateRuleId(taken: Iterable<number>): number | null {
  const used = new Set(taken);
  for (let id = EMBED_RULE_ID_MIN; id <= EMBED_RULE_ID_MAX; id++) if (!used.has(id)) return id;
  return null;
}

/** Whether an installed rule is exactly the embed rule for `tabId`. */
function ruleTargetsTab(rule: { condition?: { tabIds?: number[] } }, tabId: number): boolean {
  const ids = rule.condition?.tabIds;
  return Array.isArray(ids) && ids.length === 1 && ids[0] === tabId;
}

/**
 * Install (or keep) the rule for `tabId`. `remembered` maps every known workspace tab to its
 * rule id. Returns the rule id now in force, or null when no id is free.
 */
export async function installEmbedRule(api: SessionRulesApi, tabId: number, remembered: ReadonlyMap<number, number>, protectedDomains: string[] = []): Promise<number | null> {
  const installed = await api.getSessionRules();
  const own = remembered.get(tabId);
  if (own !== undefined) {
    const current = installed.find((r) => r.id === own);
    const exclusions = (current?.condition as EmbedRule['condition'] | undefined)?.excludedRequestDomains ?? [];
    if (current && ruleTargetsTab(current, tabId) && JSON.stringify([...exclusions].sort()) === JSON.stringify([...new Set(protectedDomains)].sort())) return own;
  }
  const taken = [...installed.filter((r) => r.id !== own).map((r) => r.id), ...[...remembered.entries()].filter(([t]) => t !== tabId).map(([, id]) => id)];
  const ruleId = own !== undefined && !taken.includes(own) ? own : allocateRuleId(taken);
  if (ruleId === null) return null;
  await api.updateSessionRules({ removeRuleIds: [ruleId], addRules: [embedRule(ruleId, tabId, protectedDomains)] });
  return ruleId;
}

/** Remove the given rule ids (ids outside the owned range are ignored). */
export async function removeEmbedRules(api: SessionRulesApi, ruleIds: number[]): Promise<void> {
  const ids = ruleIds.filter(isEmbedRuleId);
  if (ids.length > 0) await api.updateSessionRules({ removeRuleIds: ids });
}

/** Owned rules that no remembered tab accounts for (left behind by a worker that lost its state). */
export function orphanRuleIds(installed: Array<{ id: number }>, remembered: ReadonlyMap<number, number>): number[] {
  const kept = new Set(remembered.values());
  return installed.map((r) => r.id).filter((id) => isEmbedRuleId(id) && !kept.has(id));
}
