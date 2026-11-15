import { describe, expect, it } from 'vitest';
import {
  EMBED_RULE_ID_MAX,
  EMBED_RULE_ID_MIN,
  allocateRuleId,
  embedRule,
  installEmbedRule,
  orphanRuleIds,
  removeEmbedRules,
  type EmbedRule,
  type SessionRulesApi,
} from '../../src/core/embed/rules.js';
import { WORKSPACE_TABS_KEY, WorkspaceTabs, isManagerTabUrl } from '../../src/core/embed/workspace-tabs.js';

const MANAGER = 'chrome-extension://aaaabbbbccccddddaaaabbbbccccdddd/manager.html';

/** declarativeNetRequest session rules, in memory. */
function fakeDnr(initial: Array<{ id: number; condition?: { tabIds?: number[] } }> = []) {
  const rules = new Map<number, { id: number; condition?: { tabIds?: number[] } } | EmbedRule>(initial.map((r) => [r.id, r]));
  const calls: Array<{ removeRuleIds?: number[]; addRules?: EmbedRule[] }> = [];
  const api: SessionRulesApi = {
    getSessionRules: async () => [...rules.values()].map((r) => JSON.parse(JSON.stringify(r))),
    updateSessionRules: async (options) => {
      calls.push(options);
      for (const id of options.removeRuleIds ?? []) rules.delete(id);
      for (const rule of options.addRules ?? []) {
        if (rules.has(rule.id)) throw new Error(`Rule with id ${rule.id} already exists`);
        rules.set(rule.id, rule);
      }
    },
  };
  return { api, rules, calls };
}

function memoryStore(initial: Record<string, unknown> = {}) {
  const data: Record<string, unknown> = { ...initial };
  return {
    data,
    get: async (key: string) => (key in data ? { [key]: JSON.parse(JSON.stringify(data[key])) } : {}),
    set: async (items: Record<string, unknown>) => {
      for (const [k, v] of Object.entries(items)) data[k] = JSON.parse(JSON.stringify(v));
    },
  };
}

describe('embed rule', () => {
  it('removes the framing headers from sub-frame documents of one tab only', () => {
    expect(embedRule(1000, 42)).toEqual({
      id: 1000,
      priority: 1,
      action: {
        type: 'modifyHeaders',
        responseHeaders: [
          { header: 'x-frame-options', operation: 'remove' },
          { header: 'content-security-policy', operation: 'remove' },
          { header: 'content-security-policy-report-only', operation: 'remove' },
        ],
      },
      condition: { tabIds: [42], resourceTypes: ['sub_frame'] },
    });
  });

  it('allocates the lowest free id in its own range', () => {
    expect(allocateRuleId([])).toBe(EMBED_RULE_ID_MIN);
    expect(allocateRuleId([1000, 1001, 1003, 5])).toBe(1002);
    const all = Array.from({ length: EMBED_RULE_ID_MAX - EMBED_RULE_ID_MIN + 1 }, (_, i) => EMBED_RULE_ID_MIN + i);
    expect(allocateRuleId(all)).toBeNull();
  });

  it('installs once per tab, reuses the remembered id, and replaces a rule that targets another tab', async () => {
    const { api, rules, calls } = fakeDnr([{ id: 7, condition: { tabIds: [1] } }]);
    const first = await installEmbedRule(api, 42, new Map());
    expect(first).toBe(1000);
    expect(rules.get(1000)).toEqual(embedRule(1000, 42));
    // Already in force: nothing written.
    expect(await installEmbedRule(api, 42, new Map([[42, 1000]]))).toBe(1000);
    expect(calls).toHaveLength(1);
    // A second tab gets the next id; the first keeps its own.
    expect(await installEmbedRule(api, 43, new Map([[42, 1000]]))).toBe(1001);
    // The remembered rule vanished (extension reloaded): re-installed under the same id.
    rules.delete(1001);
    expect(await installEmbedRule(api, 43, new Map([[42, 1000], [43, 1001]]))).toBe(1001);
    expect(rules.get(1001)).toEqual(embedRule(1001, 43));
    // Someone else's rule (id 7) is never touched.
    expect(rules.get(7)).toEqual({ id: 7, condition: { tabIds: [1] } });
  });

  it('removes only ids it owns and finds orphans', async () => {
    const { api, rules } = fakeDnr([{ id: 7 }, { id: 1000 }, { id: 1001 }]);
    expect(orphanRuleIds([...rules.values()], new Map([[42, 1000]]))).toEqual([1001]);
    await removeEmbedRules(api, [7, 1001]);
    expect([...rules.keys()]).toEqual([7, 1000]);
  });
});

describe('workspace tabs bookkeeping', () => {
  function setup(opts: { store?: ReturnType<typeof memoryStore>; dnr?: ReturnType<typeof fakeDnr>; urls?: Map<number, string | null> } = {}) {
    const store = opts.store ?? memoryStore();
    const dnr = opts.dnr ?? fakeDnr();
    const urls = opts.urls ?? new Map<number, string | null>();
    const tabs = new WorkspaceTabs({
      store,
      rules: dnr.api,
      tabUrl: async (tabId) => urls.get(tabId) ?? null,
      managerUrl: MANAGER,
    });
    return { store, dnr, urls, tabs };
  }

  it('recognises the manager page and nothing that only looks like it', () => {
    expect(isManagerTabUrl(MANAGER, MANAGER)).toBe(true);
    expect(isManagerTabUrl(`${MANAGER}?surface=page`, MANAGER)).toBe(true);
    expect(isManagerTabUrl(`${MANAGER}#x`, MANAGER)).toBe(true);
    expect(isManagerTabUrl(`${MANAGER}.evil`, MANAGER)).toBe(false);
    expect(isManagerTabUrl('https://claude.ai/', MANAGER)).toBe(false);
    expect(isManagerTabUrl(null, MANAGER)).toBe(false);
  });

  it('remembers a tab on hello, installs its rule, and survives a worker restart', async () => {
    const { store, dnr, urls, tabs } = setup();
    urls.set(5, MANAGER);
    expect(await tabs.hello(5)).toEqual({ embedding: true });
    expect(tabs.has(5)).toBe(true);
    expect(store.data[WORKSPACE_TABS_KEY]).toEqual({ '5': 1000 });
    expect(dnr.rules.get(1000)).toEqual(embedRule(1000, 5));

    // A new worker reads the same session storage and rules.
    const again = new WorkspaceTabs({ store, rules: dnr.api, tabUrl: async (id) => urls.get(id) ?? null, managerUrl: MANAGER });
    expect(again.has(5)).toBe(false);
    await again.ready();
    expect(again.has(5)).toBe(true);
    expect(await again.hello(5)).toEqual({ embedding: true });
    expect([...dnr.rules.keys()]).toEqual([1000]);
  });

  it("keeps a workspace tab whose address it cannot read: the extension never sees its own page's address", async () => {
    const store = memoryStore();
    const dnr = fakeDnr();
    // How Chrome answers without the "tabs" permission: the tabs exist, their addresses are hidden.
    const hidden = new Set([5, 6]);
    const tabs = new WorkspaceTabs({ store, rules: dnr.api, tabUrl: async (id) => (hidden.has(id) ? undefined : null), managerUrl: MANAGER });
    await tabs.hello(5);
    // A second workspace tab saying hello used to drop the first one's rule.
    await tabs.hello(6);
    expect(tabs.has(5) && tabs.has(6)).toBe(true);
    expect(dnr.rules.size).toBe(2);
    // So did a worker restart.
    const restarted = new WorkspaceTabs({ store, rules: dnr.api, tabUrl: async (id) => (hidden.has(id) ? undefined : null), managerUrl: MANAGER });
    await restarted.prune();
    expect(restarted.has(5) && restarted.has(6)).toBe(true);
    expect(dnr.rules.size).toBe(2);
    // A tab that is gone, or seen showing another address, is still forgotten.
    hidden.delete(6);
    await restarted.prune();
    expect(restarted.has(6)).toBe(false);
    expect(dnr.rules.size).toBe(1);
    const seen = new WorkspaceTabs({ store, rules: dnr.api, tabUrl: async () => 'https://example.com/', managerUrl: MANAGER });
    await seen.prune();
    expect(seen.has(5)).toBe(false);
    expect(dnr.rules.size).toBe(0);
  });

  it('forgets a closed tab and removes its rule', async () => {
    const { store, dnr, urls, tabs } = setup();
    urls.set(5, MANAGER);
    urls.set(6, MANAGER);
    await tabs.hello(5);
    await tabs.hello(6);
    expect([...dnr.rules.keys()]).toEqual([1000, 1001]);
    await tabs.forget(5);
    expect(tabs.has(5)).toBe(false);
    expect([...dnr.rules.keys()]).toEqual([1001]);
    expect(store.data[WORKSPACE_TABS_KEY]).toEqual({ '6': 1001 });
    // The next tab reuses the freed id.
    urls.set(8, MANAGER);
    await tabs.hello(8);
    expect(dnr.rules.get(1000)).toEqual(embedRule(1000, 8));
  });

  it('prunes tabs that navigated away or closed, and rules nobody owns', async () => {
    const dnr = fakeDnr([{ id: 1500, condition: { tabIds: [77] } }, { id: 3 }]);
    const store = memoryStore({ [WORKSPACE_TABS_KEY]: { '5': 1000, '6': 1001, '9': null } });
    dnr.rules.set(1000, embedRule(1000, 5));
    dnr.rules.set(1001, embedRule(1001, 6));
    const urls = new Map<number, string | null>([
      [5, `${MANAGER}?surface=page`],
      [6, 'https://claude.ai/'],
      // 9: closed while the worker slept
    ]);
    const { tabs } = setup({ store, dnr, urls });
    await tabs.prune();
    expect(tabs.ids()).toEqual([5]);
    expect([...dnr.rules.keys()].sort()).toEqual([1000, 3]);
    expect(store.data[WORKSPACE_TABS_KEY]).toEqual({ '5': 1000 });
  });

  it('checks the other remembered tabs on hello', async () => {
    const { dnr, urls, tabs } = setup();
    urls.set(5, MANAGER);
    await tabs.hello(5);
    urls.set(5, 'https://example.com/');
    urls.set(6, MANAGER);
    await tabs.hello(6);
    expect(tabs.ids()).toEqual([6]);
    expect([...dnr.rules.values()]).toEqual([embedRule(1000, 6)]);
  });

  it('still remembers the tab when rules are unavailable, and says embedding is off', async () => {
    const store = memoryStore();
    const tabs = new WorkspaceTabs({ store, rules: null, tabUrl: async () => MANAGER, managerUrl: MANAGER });
    expect(await tabs.hello(5)).toEqual({ embedding: false });
    expect(tabs.has(5)).toBe(true);
    expect(store.data[WORKSPACE_TABS_KEY]).toEqual({ '5': null });
  });

  it('runs concurrent hellos one at a time without colliding ids', async () => {
    const { dnr, urls, tabs } = setup();
    for (const id of [1, 2, 3]) urls.set(id, MANAGER);
    const results = await Promise.all([tabs.hello(1), tabs.hello(2), tabs.hello(3)]);
    expect(results.every((r) => r.embedding)).toBe(true);
    expect([...dnr.rules.values()].map((r) => (r as EmbedRule).condition.tabIds[0]).sort()).toEqual([1, 2, 3]);
  });

  it('ignores malformed stored state', async () => {
    const store = memoryStore({ [WORKSPACE_TABS_KEY]: { abc: 1000, '-1': 1001, '4': 'x' } });
    const { tabs } = setup({ store });
    await tabs.ready();
    expect(tabs.ids()).toEqual([4]);
  });
});
