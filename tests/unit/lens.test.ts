import { describe, expect, it } from 'vitest';
import { DEFAULT_SETTINGS, normalizeSettings, type ConversationRecord } from '../../src/core/schema.js';
import {
  DATE_BUCKET_LABELS,
  EMPTY_LENS_FILTERS,
  SESSION_KIND_LABELS,
  SURFACE_GROUP_BY,
  activityTime,
  applyLensFilters,
  availableGroupBy,
  collapseToggleId,
  countLens,
  createdTime,
  dateBucketOf,
  dateBucketOfTime,
  groupLens,
  hitConversation,
  isGroupCollapsed,
  isLensFiltered,
  legacyGroupId,
  lensFilterCount,
  lensGroupLabel,
  sanitizeGroupBy,
  sanitizeSort,
  selfConversation,
  sortLens,
  toggleLensFilter,
  type LensFilters,
} from '../../src/entrypoints/manager/workspace/lens.js';

/** Local noon on a given day, so local calendar days are unambiguous in any time zone. */
const noon = (y: number, m: number, d: number) => new Date(y, m - 1, d, 12, 0, 0).getTime();
const iso = (ms: number) => new Date(ms).toISOString();
const NOW = new Date(2026, 10, 12, 15, 30, 0).getTime(); // 12 Nov 2026, 15:30 local

let counter = 0;
function conv(over: Partial<ConversationRecord> & { at?: number }): ConversationRecord {
  const { at = NOW, ...rest } = over;
  counter += 1;
  return {
    threadKey: rest.threadKey ?? `t${counter}`,
    provider: 'claude_code',
    accountId: 'acct_a',
    title: `Session ${counter}`,
    manualTitleOverride: null,
    createdAt: null,
    updatedAt: iso(at),
    lastCapturedAt: iso(at),
    messageCount: 1,
    project: '',
    workflowState: 'active',
    ...rest,
  } as unknown as ConversationRecord;
}

const keys = (list: readonly ConversationRecord[]) => list.map((c) => c.threadKey);
const accountOf = (c: ConversationRecord) => c.accountId || null;

describe('lens: filters', () => {
  const code = conv({ threadKey: 'code', provider: 'claude_code', accountId: 'a1' });
  const codex = conv({ threadKey: 'codex', provider: 'codex', accountId: 'a2' });
  const chat = conv({ threadKey: 'chat', provider: 'chatgpt', accountId: 'a2' });
  const bot = conv({ threadKey: 'bot', provider: 'grok_bot', accountId: 'a3' });
  const all = [code, codex, chat, bot];

  it('keeps everything when nothing is selected', () => {
    expect(isLensFiltered(EMPTY_LENS_FILTERS)).toBe(false);
    expect(applyLensFilters(all, EMPTY_LENS_FILTERS, selfConversation, accountOf)).toBe(all);
  });

  it('ORs inside a dimension', () => {
    const f: LensFilters = { ...EMPTY_LENS_FILTERS, kinds: ['coding', 'bots'] };
    expect(keys(applyLensFilters(all, f, selfConversation))).toEqual(['code', 'codex', 'bot']);
    const p: LensFilters = { ...EMPTY_LENS_FILTERS, providers: ['claude_code', 'chatgpt'] };
    expect(keys(applyLensFilters(all, p, selfConversation))).toEqual(['code', 'chat']);
  });

  it('ANDs across dimensions', () => {
    const f: LensFilters = { kinds: ['coding'], providers: ['codex', 'chatgpt'], accounts: ['a2'] };
    expect(keys(applyLensFilters(all, f, selfConversation, accountOf))).toEqual(['codex']);
    expect(lensFilterCount(f)).toBe(4);
  });

  it('filters by account only when it can tell which account a session is on', () => {
    const f: LensFilters = { ...EMPTY_LENS_FILTERS, accounts: ['a2'] };
    expect(keys(applyLensFilters(all, f, selfConversation, accountOf))).toEqual(['codex', 'chat']);
    // No way to tell: the dimension is not applied rather than hiding everything.
    expect(keys(applyLensFilters(all, f, selfConversation))).toEqual(['code', 'codex', 'chat', 'bot']);
    // A session with no account never matches an account filter.
    expect(keys(applyLensFilters(all, f, selfConversation, () => null))).toEqual([]);
  });

  it('works over search hits through an accessor', () => {
    const hits = all.map((conversation) => ({ conversation }));
    const f: LensFilters = { ...EMPTY_LENS_FILTERS, kinds: ['chats'] };
    expect(applyLensFilters(hits, f, hitConversation).map((h) => h.conversation.threadKey)).toEqual(['chat']);
  });

  it('toggles a value on and off without touching the others', () => {
    const on = toggleLensFilter(EMPTY_LENS_FILTERS, 'kinds', 'coding');
    expect(on.kinds).toEqual(['coding']);
    expect(EMPTY_LENS_FILTERS.kinds).toEqual([]);
    const two = toggleLensFilter(on, 'providers', 'codex');
    expect(two).toEqual({ kinds: ['coding'], providers: ['codex'], accounts: [] });
    expect(toggleLensFilter(two, 'kinds', 'coding').kinds).toEqual([]);
  });

  it('counts kinds, providers and accounts', () => {
    const counts = countLens(all, selfConversation, accountOf);
    expect(counts.kinds.get('coding')).toBe(2);
    expect(counts.kinds.get('chats')).toBe(1);
    expect(counts.providers.get('codex')).toBe(1);
    expect(counts.accounts.get('a2')).toBe(2);
  });
});

describe('lens: sorting', () => {
  const day = (n: number) => noon(2026, 11, n);
  const a = conv({ threadKey: 'a', title: 'Beta 10', at: day(5), createdAt: iso(day(1)), messageCount: 5 });
  const b = conv({ threadKey: 'b', title: 'alpha', at: day(9), createdAt: iso(day(2)), messageCount: 50 });
  const c = conv({ threadKey: 'c', title: 'Beta 2', at: day(7), createdAt: iso(day(8)), messageCount: 5 });
  const d = conv({ threadKey: 'd', title: 'Cherry', at: day(7), createdAt: null, messageCount: 1 });
  const list = [a, b, c, d];

  it('recent: latest activity first, ties keep their order', () => {
    expect(keys(sortLens(list, 'recent', selfConversation))).toEqual(['b', 'c', 'd', 'a']);
    expect(keys(sortLens([d, c], 'recent', selfConversation))).toEqual(['d', 'c']);
  });

  it('oldest: oldest activity first, ties keep their order', () => {
    expect(keys(sortLens(list, 'oldest', selfConversation))).toEqual(['a', 'c', 'd', 'b']);
  });

  it('created: most recently created first, falling back to activity time', () => {
    // d has no creation time, so its activity time (day 7) stands in for it.
    expect(keys(sortLens(list, 'created', selfConversation))).toEqual(['c', 'd', 'b', 'a']);
    expect(createdTime(d)).toBe(activityTime(d));
    expect(createdTime(a)).toBe(day(1));
  });

  it('title: A to Z, numbers by value, case and accents ignored', () => {
    expect(keys(sortLens(list, 'title', selfConversation))).toEqual(['b', 'c', 'a', 'd']);
    const e = conv({ threadKey: 'e', title: 'Élan' });
    const f = conv({ threadKey: 'f', title: 'elan' });
    expect(keys(sortLens([f, e], 'title', selfConversation))).toEqual(['f', 'e']);
  });

  it('title: uses the title function it is given', () => {
    const upper = sortLens(list, 'title', selfConversation, (x) => (x.threadKey === 'd' ? 'AAA' : x.title));
    expect(keys(upper)[0]).toBe('d');
  });

  it('messages: most messages first, ties keep their order', () => {
    expect(keys(sortLens(list, 'messages', selfConversation))).toEqual(['b', 'a', 'c', 'd']);
  });

  it('does not change the list it is given', () => {
    const copy = [...list];
    sortLens(list, 'title', selfConversation);
    expect(list).toEqual(copy);
  });

  it('uses the last capture when a session has no update time', () => {
    const x = conv({ threadKey: 'x', updatedAt: null, lastCapturedAt: iso(day(3)) });
    expect(activityTime(x)).toBe(day(3));
    expect(activityTime(conv({ threadKey: 'y', updatedAt: null, lastCapturedAt: 'nope' as string }))).toBe(0);
  });
});

describe('lens: date buckets (local calendar days)', () => {
  const at = (y: number, m: number, d: number, h = 12, min = 0) => new Date(y, m - 1, d, h, min).getTime();

  it('splits at local midnight, not 24 hours', () => {
    expect(dateBucketOfTime(at(2026, 11, 12, 0, 0), NOW)).toBe('today');
    expect(dateBucketOfTime(at(2026, 11, 12, 23, 59), NOW)).toBe('today');
    expect(dateBucketOfTime(at(2026, 11, 11, 23, 59), NOW)).toBe('yesterday');
    expect(dateBucketOfTime(at(2026, 11, 11, 0, 0), NOW)).toBe('yesterday');
    expect(dateBucketOfTime(at(2026, 11, 10, 23, 59), NOW)).toBe('week');
  });

  it('Previous 7 days is 2 to 7 days back; Previous 30 days is 8 to 30 days back', () => {
    expect(dateBucketOfTime(at(2026, 11, 5), NOW)).toBe('week'); // 7 days
    expect(dateBucketOfTime(at(2026, 11, 4, 23, 59), NOW)).toBe('month'); // 8 days
    expect(dateBucketOfTime(at(2026, 10, 13), NOW)).toBe('month'); // 30 days
    expect(dateBucketOfTime(at(2026, 10, 12, 23, 59), NOW)).toBe('older'); // 31 days
  });

  it('counts calendar days across month and year ends', () => {
    const jan2 = new Date(2027, 0, 2, 9, 0).getTime();
    expect(dateBucketOfTime(new Date(2026, 11, 31, 22, 0).getTime(), jan2)).toBe('week');
    expect(dateBucketOfTime(new Date(2027, 0, 1, 22, 0).getTime(), jan2)).toBe('yesterday');
  });

  it('puts the future in Today and an unreadable time in Older', () => {
    expect(dateBucketOfTime(at(2026, 11, 20), NOW)).toBe('today');
    expect(dateBucketOfTime(Number.NaN, NOW)).toBe('older');
    expect(dateBucketOfTime(0, NOW)).toBe('older');
  });

  it('reads the bucket from a session', () => {
    expect(dateBucketOf(conv({ at: at(2026, 11, 11) }), NOW)).toBe('yesterday');
  });

  it('names the buckets', () => {
    expect(DATE_BUCKET_LABELS).toEqual({
      today: 'Today',
      yesterday: 'Yesterday',
      week: 'Previous 7 days',
      month: 'Previous 30 days',
      older: 'Older',
    });
  });
});

describe('lens: grouping', () => {
  const ids = <T extends { id: string }>(groups: T[]) => groups.map((g) => g.id);

  it('none: one group holding everything in the incoming order, or nothing', () => {
    const a = conv({ threadKey: 'a' });
    const b = conv({ threadKey: 'b' });
    const groups = groupLens([b, a], 'none', selfConversation);
    expect(groups).toHaveLength(1);
    expect(groups[0].id).toBe('none:');
    expect(keys(groups[0].sessions)).toEqual(['b', 'a']);
    expect(groupLens([], 'none', selfConversation)).toEqual([]);
  });

  it('kind: coding, chats, bots, other, whatever the order of the sessions', () => {
    const list = [
      conv({ threadKey: 'chat', provider: 'chatgpt' }),
      conv({ threadKey: 'more', provider: 'perplexity' }),
      conv({ threadKey: 'bot', provider: 'grok_bot' }),
      conv({ threadKey: 'code', provider: 'claude_code' }),
      conv({ threadKey: 'code2', provider: 'codex' }),
    ];
    const groups = groupLens(list, 'kind', selfConversation);
    expect(ids(groups)).toEqual(['kind:coding', 'kind:chats', 'kind:bots', 'kind:more']);
    expect(keys(groups[0].sessions)).toEqual(['code', 'code2']);
  });

  it('keeps the incoming order inside a group and drops empty groups', () => {
    const list = [conv({ threadKey: 'c3', provider: 'chatgpt' }), conv({ threadKey: 'c1', provider: 'chatgpt' }), conv({ threadKey: 'c2', provider: 'claude' })];
    const groups = groupLens(list, 'kind', selfConversation);
    expect(ids(groups)).toEqual(['kind:chats']);
    expect(keys(groups[0].sessions)).toEqual(['c3', 'c1', 'c2']);
  });

  it('provider: biggest group first, then by name', () => {
    const list = [
      conv({ provider: 'codex' }),
      conv({ provider: 'chatgpt' }),
      conv({ provider: 'claude_code' }),
      conv({ provider: 'claude_code' }),
      conv({ provider: 'chatgpt' }),
      conv({ provider: 'claude' }),
    ];
    const groups = groupLens(list, 'provider', selfConversation);
    // Two each for Claude Code and ChatGPT: "ChatGPT" sorts before "Claude Code"; then one each, by name.
    expect(ids(groups)).toEqual(['provider:chatgpt', 'provider:claude_code', 'provider:claude', 'provider:codex']);
    expect(groups.map((g) => g.sessions.length)).toEqual([2, 2, 1, 1]);
  });

  it('repository: biggest first, then by name, with "no repository" always last', () => {
    const repoOf = (c: ConversationRecord) => (c.threadKey.startsWith('x') ? null : c.threadKey.split(':')[0]);
    const list = [
      conv({ threadKey: 'x1' }),
      conv({ threadKey: 'zeta:1' }),
      conv({ threadKey: 'x2' }),
      conv({ threadKey: 'x3' }),
      conv({ threadKey: 'alpha:1' }),
      conv({ threadKey: 'beta:1' }),
      conv({ threadKey: 'beta:2' }),
    ];
    const groups = groupLens(list, 'repository', selfConversation, { repositoryOf: repoOf });
    // The empty group has the most sessions and still comes last.
    expect(ids(groups)).toEqual(['repository:beta', 'repository:alpha', 'repository:zeta', 'repository:']);
    expect(groups[3].key).toBeNull();
    expect(groups[3].sessions).toHaveLength(3);
  });

  it('repository: falls back to what the session itself names', () => {
    const list = [conv({ provider: 'claude_code', workspacePath: '/work/acme-app' } as Partial<ConversationRecord>), conv({ provider: 'chatgpt' })];
    const groups = groupLens(list, 'repository', selfConversation);
    expect(groups[0].key).toBe('acme-app');
    expect(groups[1].key).toBeNull();
  });

  it('project: biggest first, then by name, with unassigned sessions last', () => {
    const list = [
      conv({ project: '' }),
      conv({ project: '' }),
      conv({ project: 'Zulu' }),
      conv({ project: 'Alpha' }),
      conv({ project: 'Alpha' }),
      conv({ project: 'Mike' }),
    ];
    const groups = groupLens(list, 'project', selfConversation);
    expect(ids(groups)).toEqual(['project:Alpha', 'project:Mike', 'project:Zulu', 'project:Unassigned']);
  });

  it('account: follows the order of the accounts it is given, unknown ones next, none last', () => {
    const list = [
      conv({ threadKey: 'n1', accountId: '' }),
      conv({ threadKey: 'b1', accountId: 'b' }),
      conv({ threadKey: 'q1', accountId: 'unknown' }),
      conv({ threadKey: 'a1', accountId: 'a' }),
      conv({ threadKey: 'b2', accountId: 'b' }),
    ];
    const groups = groupLens(list, 'account', selfConversation, { accountIdOf: accountOf, accountOrder: ['a', 'b', 'c'] });
    expect(ids(groups)).toEqual(['account:a', 'account:b', 'account:unknown', 'account:']);
    expect(keys(groups[1].sessions)).toEqual(['b1', 'b2']);
    // Without an order the accounts keep the order they were first seen in.
    const seen = groupLens(list, 'account', selfConversation, { accountIdOf: accountOf });
    expect(ids(seen)).toEqual(['account:b', 'account:unknown', 'account:a', 'account:']);
  });

  it('date: newest bucket first, chronological', () => {
    const day = (n: number) => new Date(2026, 10, 12 - n, 12).getTime();
    const list = [
      conv({ threadKey: 'old', at: day(60) }),
      conv({ threadKey: 'month', at: day(20) }),
      conv({ threadKey: 'today', at: day(0) }),
      conv({ threadKey: 'week', at: day(4) }),
      conv({ threadKey: 'yest', at: day(1) }),
    ];
    const groups = groupLens(list, 'date', selfConversation, { now: NOW });
    expect(ids(groups)).toEqual(['date:today', 'date:yesterday', 'date:week', 'date:month', 'date:older']);
    expect(lensGroupLabel('date', 'week')).toBe('Previous 7 days');
  });

  it('status: follows the workflow, active to archived', () => {
    const list = ['archived', 'done', 'active', 'paused', 'waiting', 'needs_review'].map((state) =>
      conv({ threadKey: state, workflowState: state as ConversationRecord['workflowState'] })
    );
    const groups = groupLens(list, 'status', selfConversation);
    expect(ids(groups)).toEqual(['status:active', 'status:needs_review', 'status:waiting', 'status:paused', 'status:done', 'status:archived']);
    expect(lensGroupLabel('status', 'needs_review')).toBe('Needs review');
  });

  it('works over search hits through an accessor', () => {
    const hits = [conv({ provider: 'chatgpt' }), conv({ provider: 'claude_code' })].map((conversation) => ({ conversation, score: 1 }));
    const groups = groupLens(hits, 'kind', hitConversation);
    expect(ids(groups)).toEqual(['kind:coding', 'kind:chats']);
    expect(groups[0].sessions[0].score).toBe(1);
  });

  it('names kinds the way the filter menus do, or the way the rail does when asked', () => {
    expect(lensGroupLabel('kind', 'coding')).toBe('Coding sessions');
    expect(lensGroupLabel('kind', 'more')).toBe('Other');
    expect(SESSION_KIND_LABELS.chats).toBe('Chats');
    expect(lensGroupLabel('kind', 'coding', { coding: 'Coding agents', chats: 'Chats', bots: 'Bots', more: 'More' })).toBe('Coding agents');
    expect(lensGroupLabel('provider', 'claude_code')).toBe('Claude Code');
  });
});

describe('lens: what each surface offers', () => {
  it('lists the choices per surface in the agreed order', () => {
    expect(SURFACE_GROUP_BY.sidebar).toEqual(['kind', 'provider', 'account', 'date', 'repository', 'none']);
    expect(SURFACE_GROUP_BY.threads).toEqual(['none', 'project', 'repository', 'account', 'kind', 'provider', 'date', 'status']);
    expect(SURFACE_GROUP_BY.dashboard).toEqual(['none', 'kind', 'provider', 'account']);
  });

  it('hides Account without a second account, and a grouping that would be one bucket', () => {
    expect(availableGroupBy('dashboard', { multiAccount: false })).toEqual(['none', 'kind', 'provider']);
    expect(availableGroupBy('dashboard', { multiAccount: true })).toEqual(['none', 'kind', 'provider', 'account']);
    expect(availableGroupBy('sidebar', { multiAccount: false, kindCount: 1, providerCount: 3 })).toEqual(['provider', 'date', 'repository', 'none']);
    expect(availableGroupBy('sidebar', { multiAccount: false, kindCount: 3, providerCount: 1 })).toEqual(['kind', 'date', 'repository', 'none']);
  });

  it('never hides the choice in force, nor None', () => {
    expect(availableGroupBy('sidebar', { multiAccount: false, kindCount: 1, providerCount: 1 }, 'account')).toEqual(['account', 'date', 'repository', 'none']);
    expect(availableGroupBy('sidebar', { multiAccount: false, kindCount: 1, providerCount: 1 }, 'kind')).toContain('kind');
  });
});

describe('lens: persisted values', () => {
  it('falls back to the surface default for an unknown or unoffered grouping', () => {
    expect(sanitizeGroupBy('sidebar', 'provider')).toBe('provider');
    expect(sanitizeGroupBy('sidebar', 'sideways')).toBe('kind');
    expect(sanitizeGroupBy('sidebar', undefined)).toBe('kind');
    expect(sanitizeGroupBy('sidebar', 'status')).toBe('kind'); // not offered in the sidebar
    expect(sanitizeGroupBy('threads', 'status')).toBe('status');
    expect(sanitizeGroupBy('threads', 7)).toBe('none');
    expect(sanitizeGroupBy('dashboard', 'date')).toBe('none');
  });

  it('falls back to recent for an unknown sort', () => {
    expect(sanitizeSort('created')).toBe('created');
    expect(sanitizeSort('newest')).toBe('recent');
    expect(sanitizeSort(null)).toBe('recent');
  });

  it('fills and sanitizes the settings fields', () => {
    const fresh = normalizeSettings({});
    expect(fresh.threadsSort).toBe('recent');
    expect(fresh.railLens).toEqual({ groupBy: 'kind', sortBy: 'recent' });
    expect(fresh.dashboardLens).toEqual({ groupBy: 'none', sortBy: 'recent' });
    const kept = normalizeSettings({
      threadsSort: 'created',
      railLens: { groupBy: 'provider', sortBy: 'title' },
      dashboardLens: { groupBy: 'account', sortBy: 'messages' },
      threadsGroupBy: 'status',
    });
    expect(kept.threadsSort).toBe('created');
    expect(kept.railLens).toEqual({ groupBy: 'provider', sortBy: 'title' });
    expect(kept.dashboardLens).toEqual({ groupBy: 'account', sortBy: 'messages' });
    expect(kept.threadsGroupBy).toBe('status');
    const junk = normalizeSettings({
      threadsSort: 'sideways',
      railLens: { groupBy: 'x', sortBy: 'y' },
      dashboardLens: 'nope',
      threadsGroupBy: 'planet',
    } as never);
    expect(junk.threadsSort).toBe('recent');
    expect(junk.railLens).toEqual({ groupBy: 'kind', sortBy: 'recent' });
    expect(junk.dashboardLens).toEqual({ groupBy: 'none', sortBy: 'recent' });
    expect(junk.threadsGroupBy).toBe(DEFAULT_SETTINGS.threadsGroupBy);
  });

  it('maps the old collapsed ids to the new ones', () => {
    expect(legacyGroupId('kind:coding')).toBe('coding');
    expect(legacyGroupId('provider:codex')).toBeNull();
    expect(isGroupCollapsed(['coding'], 'kind:coding')).toBe(true);
    expect(isGroupCollapsed(['kind:coding'], 'kind:coding')).toBe(true);
    expect(isGroupCollapsed(['chats'], 'kind:coding')).toBe(false);
    expect(isGroupCollapsed(['coding'], 'provider:coding')).toBe(false);
  });

  it('toggles under the spelling that is stored, so an old entry is removed', () => {
    expect(collapseToggleId(['chats'], 'kind:chats')).toBe('chats');
    expect(collapseToggleId(['kind:chats'], 'kind:chats')).toBe('kind:chats');
    expect(collapseToggleId([], 'kind:chats')).toBe('kind:chats');
    expect(collapseToggleId(['chats'], 'kind:coding')).toBe('kind:coding');
    expect(collapseToggleId(['x'], 'provider:codex')).toBe('provider:codex');
  });
});
