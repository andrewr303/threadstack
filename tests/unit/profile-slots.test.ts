import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  HOLD_MS,
  PROFILE_SLOTS_KEY,
  ProfileSlots,
  type ProfileSlotsEnv,
  type SeedRulesApi,
  type SlotStore,
} from '../../src/core/embed/profile-slots.js';
import { SEED_RULE_ID_MIN, seedUrl, type SeedPlan, type SeedRule } from '../../src/core/embed/profile-seed.js';

const NONCE_A = 'aaaaaaaaaaaaaaaaaaaaaaaa';
const NONCE_B = 'bbbbbbbbbbbbbbbbbbbbbbbb';

function plan(hosts: string[], nonce = NONCE_A): SeedPlan {
  return {
    steps: hosts.map((host) => ({ host, url: seedUrl(host, nonce), headers: ['a=1; Path=/'] })),
    skipped: 0,
    dropped: 0,
    truncated: false,
  };
}

function fakeRules(initial: number[] = []) {
  const rules = new Map<number, SeedRule | { id: number }>(initial.map((id) => [id, { id }]));
  const api: SeedRulesApi = {
    getSessionRules: async () => [...rules.values()].map((r) => ({ id: r.id })),
    updateSessionRules: async ({ removeRuleIds = [], addRules = [] }) => {
      for (const id of removeRuleIds) rules.delete(id);
      for (const rule of addRules) rules.set(rule.id, rule);
    },
  };
  return { api, rules };
}

function fakeStore(initial: Record<string, unknown> = {}) {
  const data: Record<string, unknown> = { ...initial };
  const store: SlotStore = {
    get: async (key) => (key in data ? { [key]: data[key] } : {}),
    set: async (items) => void Object.assign(data, items),
  };
  return { store, data };
}

let clock = 1_000;
let observing = true;
let rules: ReturnType<typeof fakeRules>;
let backing: ReturnType<typeof fakeStore>;

function make(extra: Partial<ProfileSlotsEnv> = {}) {
  return new ProfileSlots({
    store: backing.store,
    rules: rules.api,
    now: () => clock,
    observesResponses: () => observing,
    ...extra,
  });
}

beforeEach(() => {
  clock = 1_000;
  observing = true;
  rules = fakeRules();
  backing = fakeStore();
});

describe('claiming a slot', () => {
  it('is ready at once when the account has nothing to seed', async () => {
    const slots = make();
    expect(await slots.claim(5, 'anthropic', 'acct_a', plan([]))).toEqual({ ok: true, steps: [] });
    expect(slots.accountFor(5, 'anthropic')).toBe('acct_a');
    expect(rules.rules.size).toBe(0);
  });

  it('installs one seeding rule per address, limited to the tab, and is not ready until the page says so', async () => {
    const slots = make();
    const result = await slots.claim(5, 'openai', 'acct_a', plan(['chatgpt.com', 'auth.openai.com']));
    expect(result).toEqual({ ok: true, steps: [seedUrl('chatgpt.com', NONCE_A), seedUrl('auth.openai.com', NONCE_A)] });
    expect(rules.rules.size).toBe(2);
    for (const rule of rules.rules.values()) {
      expect((rule as SeedRule).condition.tabIds).toEqual([5]);
      expect(rule.id).toBeGreaterThanOrEqual(SEED_RULE_ID_MIN);
    }
    // fail closed: a seeding slot shows no account yet
    expect(slots.accountFor(5, 'openai')).toBeNull();
    expect(slots.slot(5, 'openai')?.status).toBe('seeding');
  });

  it('refuses a second account in the same tab and realm until the page is reloaded', async () => {
    const slots = make();
    await slots.claim(5, 'anthropic', 'acct_a', plan([]));
    expect(await slots.claim(5, 'anthropic', 'acct_b', plan([]))).toMatchObject({ ok: false, code: 'needs_reload' });
    expect(slots.accountFor(5, 'anthropic')).toBe('acct_a');
  });

  it('refuses a second account while the first is still seeding, leaving its rules alone', async () => {
    const slots = make();
    await slots.claim(5, 'anthropic', 'acct_a', plan(['claude.ai']));
    const before = [...rules.rules.keys()];
    expect(await slots.claim(5, 'anthropic', 'acct_b', plan(['claude.ai'], NONCE_B))).toMatchObject({ code: 'needs_reload' });
    expect([...rules.rules.keys()]).toEqual(before);
  });

  it('answers a repeat claim of a ready slot with nothing to load', async () => {
    const slots = make();
    await slots.claim(5, 'anthropic', 'acct_a', plan([]));
    expect(await slots.claim(5, 'anthropic', 'acct_a', plan(['claude.ai']))).toEqual({ ok: true, steps: [] });
    expect(rules.rules.size).toBe(0);
  });

  it('replaces the rules of a repeated claim of a slot that is still seeding', async () => {
    const slots = make();
    await slots.claim(5, 'anthropic', 'acct_a', plan(['claude.ai']));
    await slots.claim(5, 'anthropic', 'acct_a', plan(['claude.ai'], NONCE_B));
    expect(rules.rules.size).toBe(1);
    expect(slots.slot(5, 'anthropic')?.nonce).toBe(NONCE_B);
  });

  it('keeps slots apart per tab and per realm', async () => {
    const slots = make();
    await slots.claim(5, 'anthropic', 'acct_a', plan([]));
    await slots.claim(6, 'anthropic', 'acct_b', plan([]));
    await slots.claim(5, 'openai', 'acct_c', plan([]));
    expect(slots.accountFor(5, 'anthropic')).toBe('acct_a');
    expect(slots.accountFor(6, 'anthropic')).toBe('acct_b');
    expect(slots.accountFor(5, 'openai')).toBe('acct_c');
    expect(slots.accountFor(6, 'openai')).toBeNull();
    expect(slots.tabsShowing('acct_a')).toEqual([5]);
  });

  it('gives different seeding claims different rule ids', async () => {
    const slots = make();
    await slots.claim(5, 'anthropic', 'acct_a', plan(['claude.ai']));
    await slots.claim(6, 'anthropic', 'acct_b', plan(['claude.ai'], NONCE_B));
    expect(new Set(rules.rules.keys()).size).toBe(2);
  });

  it('fails without a slot when the rules API is missing or rejects', async () => {
    const noRules = make({ rules: null });
    expect(await noRules.claim(5, 'anthropic', 'acct_a', plan(['claude.ai']))).toMatchObject({ ok: false });
    expect(noRules.accountFor(5, 'anthropic')).toBeNull();

    const broken = make({
      rules: { getSessionRules: async () => [], updateSessionRules: async () => Promise.reject(new Error('no')) },
    });
    expect(await broken.claim(6, 'anthropic', 'acct_a', plan(['claude.ai']))).toMatchObject({ ok: false });
    expect(broken.slot(6, 'anthropic')).toBeNull();
  });

  it('never answers for a missing or non-numeric tab', () => {
    const slots = make();
    expect(slots.accountFor(undefined, 'anthropic')).toBeNull();
  });
});

describe('seeding responses and readiness', () => {
  it('recognises seeding addresses and counts them off', async () => {
    const slots = make();
    await slots.claim(5, 'anthropic', 'acct_a', plan(['claude.ai']));
    expect(slots.noteSeedResponse(5, 'https://claude.ai/api/x')).toBe(false);
    expect(slots.noteSeedResponse(5, seedUrl('claude.ai', NONCE_A))).toBe(true);
    expect(slots.slot(5, 'anthropic')?.pending).toEqual([]);
  });

  it('still treats a seeding address of an earlier claim as a seeding address', async () => {
    const slots = make();
    await slots.claim(5, 'anthropic', 'acct_a', plan(['claude.ai']));
    expect(slots.noteSeedResponse(5, seedUrl('claude.ai', NONCE_B))).toBe(true);
    expect(slots.slot(5, 'anthropic')?.pending).toHaveLength(1);
  });

  it('becomes ready once every address was answered, and removes its rules', async () => {
    const slots = make();
    await slots.claim(5, 'anthropic', 'acct_a', plan(['claude.ai', 'api.claude.ai']));
    slots.noteSeedResponse(5, seedUrl('claude.ai', NONCE_A));
    slots.noteSeedResponse(5, seedUrl('api.claude.ai', NONCE_A));
    expect(await slots.markReady(5, 'anthropic')).toEqual({ ok: true });
    expect(slots.accountFor(5, 'anthropic')).toBe('acct_a');
    expect(rules.rules.size).toBe(0);
    expect(slots.slot(5, 'anthropic')?.readyAt).toBe(clock);
  });

  it('is not ready when an address got no answer, drops the slot and its rules so the page may claim again', async () => {
    const slots = make();
    await slots.claim(5, 'anthropic', 'acct_a', plan(['claude.ai', 'api.claude.ai']));
    slots.noteSeedResponse(5, seedUrl('claude.ai', NONCE_A));
    expect(await slots.markReady(5, 'anthropic')).toMatchObject({ ok: false });
    expect(slots.accountFor(5, 'anthropic')).toBeNull();
    expect(slots.slot(5, 'anthropic')).toBeNull();
    expect(rules.rules.size).toBe(0);
    // another account may now claim
    expect(await slots.claim(5, 'anthropic', 'acct_b', plan([]))).toEqual({ ok: true, steps: [] });
  });

  it('takes the page\'s word for it when the worker cannot observe responses', async () => {
    observing = false;
    const slots = make();
    await slots.claim(5, 'anthropic', 'acct_a', plan(['claude.ai']));
    expect(await slots.markReady(5, 'anthropic')).toEqual({ ok: true });
    expect(slots.accountFor(5, 'anthropic')).toBe('acct_a');
  });

  it('treats a missing observesResponses option as observing', async () => {
    const slots = make({ observesResponses: undefined });
    await slots.claim(5, 'anthropic', 'acct_a', plan(['claude.ai']));
    expect(await slots.markReady(5, 'anthropic')).toMatchObject({ ok: false });
  });

  it('refuses to ready a slot nobody claimed, in this tab or another', async () => {
    const slots = make();
    expect(await slots.markReady(5, 'anthropic')).toMatchObject({ ok: false, code: 'not_allowed' });
    await slots.claim(6, 'anthropic', 'acct_a', plan(['claude.ai']));
    expect(await slots.markReady(5, 'anthropic')).toMatchObject({ ok: false, code: 'not_allowed' });
    expect(slots.accountFor(5, 'anthropic')).toBeNull();
  });

  it('answers ok for a slot that is already ready', async () => {
    const slots = make();
    await slots.claim(5, 'anthropic', 'acct_a', plan([]));
    expect(await slots.markReady(5, 'anthropic')).toEqual({ ok: true });
  });
});

describe('what a frame is', () => {
  it('knows nothing about a frame nobody reported, and nothing about an unknown tab', () => {
    const slots = make();
    expect(slots.kindOf(5, 3)).toBe('unknown');
    slots.frameSeen(5, 4, true);
    expect(slots.kindOf(5, 3)).toBe('unknown');
    expect(slots.kindOf(99, 4)).toBe('unknown');
  });

  it('remembers what the frame said about itself, per tab', () => {
    const slots = make();
    slots.frameSeen(5, 3, true);
    slots.frameSeen(5, 4, false);
    expect(slots.kindOf(5, 3)).toBe('profile');
    expect(slots.kindOf(5, 4)).toBe('plain');
    expect(slots.kindOf(6, 3)).toBe('unknown');
  });

  it('lets a frame inside a known frame be what its parent is, and remembers it', () => {
    const slots = make();
    slots.frameSeen(5, 3, true);
    expect(slots.kindOf(5, 8, 3)).toBe('profile');
    expect(slots.kindOf(5, 8)).toBe('profile');
  });

  it('does not guess from an unknown parent or from the top frame', () => {
    const slots = make();
    slots.frameSeen(5, 3, true);
    expect(slots.kindOf(5, 8, 7)).toBe('unknown');
    expect(slots.kindOf(5, 9, 0)).toBe('unknown');
  });

  it('prefers a frame\'s own report over its parent\'s kind', () => {
    const slots = make();
    slots.frameSeen(5, 3, true);
    slots.frameSeen(5, 8, false);
    expect(slots.kindOf(5, 8, 3)).toBe('plain');
  });
});

describe('responses held for a frame of unknown kind', () => {
  const held = (frameId: number, url = 'https://claude.ai/api/a') => ({ frameId, url, headers: ['s=1'] });

  it('are handed back when the frame turns out to be a profile frame', () => {
    const slots = make();
    slots.hold(5, held(3));
    slots.hold(5, held(4));
    const got = slots.frameSeen(5, 3, true);
    expect(got.map((h) => h.frameId)).toEqual([3]);
    // only that frame's responses were released; the other frame's are still waiting
    expect(slots.frameSeen(5, 4, true)).toHaveLength(1);
  });

  it('are dropped when the frame turns out to be an ordinary frame', () => {
    const slots = make();
    slots.hold(5, held(3));
    expect(slots.frameSeen(5, 3, false)).toEqual([]);
    // and are gone for good
    expect(slots.frameSeen(5, 3, true)).toEqual([]);
  });

  it('are handed back once only', () => {
    const slots = make();
    slots.hold(5, held(3));
    expect(slots.frameSeen(5, 3, true)).toHaveLength(1);
    expect(slots.frameSeen(5, 3, true)).toEqual([]);
  });

  it('are never handed to another tab\'s frame of the same id', () => {
    const slots = make();
    slots.hold(5, held(3));
    expect(slots.frameSeen(6, 3, true)).toEqual([]);
    expect(slots.frameSeen(5, 3, true)).toHaveLength(1);
  });

  it('are forgotten by later holds once older than HOLD_MS', () => {
    const slots = make();
    slots.hold(5, held(3, 'https://claude.ai/old'));
    clock += HOLD_MS;
    slots.hold(5, held(4, 'https://claude.ai/new'));
    expect(slots.frameSeen(5, 3, true)).toEqual([]);
    expect(slots.frameSeen(5, 4, true)).toHaveLength(1);
  });

  it('are kept while younger than HOLD_MS', () => {
    const slots = make();
    slots.hold(5, held(3));
    clock += HOLD_MS - 1;
    slots.hold(5, held(4));
    expect(slots.frameSeen(5, 3, true)).toHaveLength(1);
  });

  it('are dropped when the frame only reports itself after HOLD_MS, even if nothing else was held', () => {
    const slots = make();
    slots.hold(5, held(3));
    clock += HOLD_MS + 1;
    expect(slots.frameSeen(5, 3, true)).toEqual([]);
  });
});

describe('resetting and pruning', () => {
  it('resetting a tab drops its slots, frames and rules and leaves other tabs alone', async () => {
    const slots = make();
    await slots.claim(5, 'anthropic', 'acct_a', plan(['claude.ai']));
    await slots.claim(6, 'anthropic', 'acct_b', plan(['claude.ai'], NONCE_B));
    slots.frameSeen(5, 3, true);
    slots.frameSeen(6, 3, true);
    const ids6 = slots.slot(6, 'anthropic')!.ruleIds;
    await slots.resetTab(5);
    expect(slots.slot(5, 'anthropic')).toBeNull();
    expect(slots.kindOf(5, 3)).toBe('unknown');
    expect(slots.slot(6, 'anthropic')?.accountId).toBe('acct_b');
    expect(slots.kindOf(6, 3)).toBe('profile');
    expect([...rules.rules.keys()]).toEqual(ids6);
  });

  it('lets the same tab claim a different account after a reset', async () => {
    const slots = make();
    await slots.claim(5, 'anthropic', 'acct_a', plan([]));
    await slots.resetTab(5);
    expect(await slots.claim(5, 'anthropic', 'acct_b', plan([]))).toEqual({ ok: true, steps: [] });
    expect(slots.accountFor(5, 'anthropic')).toBe('acct_b');
  });

  it('does nothing for a tab it never saw', async () => {
    const slots = make();
    await slots.resetTab(42);
    expect(backing.data[PROFILE_SLOTS_KEY]).toBeUndefined();
  });

  it('prune forgets tabs that are no longer workspace tabs and keeps the rest', async () => {
    const slots = make();
    await slots.claim(5, 'anthropic', 'acct_a', plan(['claude.ai']));
    await slots.claim(6, 'anthropic', 'acct_b', plan(['claude.ai'], NONCE_B));
    const ids6 = slots.slot(6, 'anthropic')!.ruleIds;
    await slots.prune((tabId) => tabId === 6);
    expect(slots.slot(5, 'anthropic')).toBeNull();
    expect(slots.slot(6, 'anthropic')?.accountId).toBe('acct_b');
    expect([...rules.rules.keys()]).toEqual(ids6);
  });

  it('prune removes seeding rules nobody owns but leaves rules of other owners', async () => {
    rules = fakeRules([SEED_RULE_ID_MIN + 50, 1001, 3500]);
    const slots = make();
    await slots.prune(() => true);
    expect([...rules.rules.keys()].sort()).toEqual([1001, 3500]);
  });
});

describe('remembering across worker restarts', () => {
  it('writes slots and frames under the session key and revives them', async () => {
    const first = make();
    await first.claim(5, 'anthropic', 'acct_a', plan([]));
    first.frameSeen(5, 3, true);
    first.frameSeen(5, 4, false);
    await first.prune(() => true); // waits for the queued save
    expect(backing.data[PROFILE_SLOTS_KEY]).toBeTruthy();

    const second = make();
    await second.ready();
    expect(second.accountFor(5, 'anthropic')).toBe('acct_a');
    expect(second.kindOf(5, 3)).toBe('profile');
    expect(second.kindOf(5, 4)).toBe('plain');
  });

  it('does not persist responses that are still held', async () => {
    const first = make();
    await first.claim(5, 'anthropic', 'acct_a', plan([]));
    first.hold(5, { frameId: 3, url: 'https://claude.ai/a', headers: ['s=1'] });
    await first.resetTab(99);
    const second = make();
    await second.ready();
    expect(second.frameSeen(5, 3, true)).toEqual([]);
  });

  it('skips malformed remembered entries instead of trusting them', async () => {
    backing = fakeStore({
      [PROFILE_SLOTS_KEY]: {
        '5': {
          slots: {
            anthropic: { accountId: 'acct_a', status: 'ready' },
            openai: { accountId: 7, status: 'ready' },
            xai: { accountId: 'acct_x', status: 'maybe' },
            cursor: null,
          },
          frames: { '3': 'profile', '4': 'bogus', '0': 'profile', '-1': 'plain', x: 'plain' },
        },
        '-3': { slots: {}, frames: {} },
        abc: { slots: {}, frames: {} },
        '6': 'nonsense',
      },
    });
    const slots = make();
    await slots.ready();
    expect(slots.accountFor(5, 'anthropic')).toBe('acct_a');
    expect(slots.accountFor(5, 'openai')).toBeNull();
    expect(slots.accountFor(5, 'xai')).toBeNull();
    expect(slots.accountFor(5, 'cursor')).toBeNull();
    expect(slots.kindOf(5, 3)).toBe('profile');
    expect(slots.kindOf(5, 4)).toBe('unknown');
    expect(slots.kindOf(5, 0)).toBe('unknown');
    expect(slots.tabsShowing('acct_a')).toEqual([5]);
  });

  it('starts empty when session storage fails or is missing', async () => {
    const failing = make({ store: { get: async () => Promise.reject(new Error('x')), set: async () => undefined } });
    await failing.ready();
    expect(failing.accountFor(5, 'anthropic')).toBeNull();
    const none = make({ store: null });
    expect(await none.claim(5, 'anthropic', 'acct_a', plan([]))).toEqual({ ok: true, steps: [] });
    expect(none.accountFor(5, 'anthropic')).toBe('acct_a');
  });

  it('keeps answering from memory when saving fails', async () => {
    const slots = make({ store: { get: async () => ({}), set: vi.fn(async () => Promise.reject(new Error('full'))) } });
    expect(await slots.claim(5, 'anthropic', 'acct_a', plan([]))).toEqual({ ok: true, steps: [] });
    expect(slots.accountFor(5, 'anthropic')).toBe('acct_a');
  });
});
