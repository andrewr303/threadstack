import 'fake-indexeddb/auto';
import { describe, expect, it } from 'vitest';
import {
  groupByRepository,
  hasRepositoryOwner,
  normalizePullRequestUrl,
  normalizeRepository,
  repositoryName,
  threadRepository,
} from '../../src/core/repository.js';
import { providerCategory } from '../../src/core/providers.js';
import { ThreadkeeperDB, ensureStarterCollectionsAndSettings, upsertThread } from '../../src/core/db.js';
import { decideProject, type OrganizeContext } from '../../src/core/auto-organize.js';
import { exportPortableBundle, exportThreadToMarkdown, importPortableBundle } from '../../src/core/adapters.js';
import { MemorySearchIndex, matchesScopeFilter } from '../../src/core/search.js';
import { buildThreadKey, normalizeSettings, type ConversationRecord } from '../../src/core/schema.js';

const coding = (provider: string) => providerCategory(provider) === 'coding_agent';

describe('normalizeRepository', () => {
  it('reads https, ssh and owner/name forms, lowercased and without .git', () => {
    expect(normalizeRepository('https://github.com/Acme/App.git')).toBe('acme/app');
    expect(normalizeRepository('https://www.github.com/Acme/App/tree/main/src')).toBe('acme/app');
    expect(normalizeRepository('git@github.com:Acme/App.git')).toBe('acme/app');
    expect(normalizeRepository('ssh://git@gitlab.com/a/b')).toBe('a/b');
    expect(normalizeRepository('https://bitbucket.org/Team/Repo')).toBe('team/repo');
    expect(normalizeRepository('Acme/App')).toBe('acme/app');
    expect(normalizeRepository('  Acme / App  ')).toBe('acme/app');
  });

  it('keeps a bare name as a name', () => {
    expect(normalizeRepository('Billing-API')).toBe('billing-api');
    expect(normalizeRepository('app.git')).toBe('app');
  });

  it('returns null for junk, other hosts over https and too many segments', () => {
    for (const bad of ['', '   ', null, undefined, '..', 'a b', 'a/b/c', 'https://example.com/a/b', 'https://github.com/a', 'x'.repeat(401)]) {
      expect(normalizeRepository(bad as string | null | undefined)).toBeNull();
    }
  });
});

describe('normalizePullRequestUrl', () => {
  it('canonicalizes pull and merge request addresses and drops query and fragment', () => {
    expect(normalizePullRequestUrl('https://github.com/Acme/App/pull/3?diff=split#files')).toBe('https://github.com/acme/app/pull/3');
    expect(normalizePullRequestUrl('https://gitlab.com/A/B/merge_requests/4/diffs')).toBe('https://gitlab.com/a/b/merge_requests/4');
    expect(normalizePullRequestUrl('https://github.com/a/b/pulls/9')).toBe('https://github.com/a/b/pull/9');
  });

  it('rejects other pages, other hosts, plain http and junk', () => {
    for (const bad of ['https://github.com/a/b/issues/3', 'http://github.com/a/b/pull/3', 'https://example.com/a/b/pull/3', 'nope', '', null]) {
      expect(normalizePullRequestUrl(bad as string | null)).toBeNull();
    }
  });
});

describe('repository helpers', () => {
  it('splits the name from the owner', () => {
    expect(repositoryName('acme/app')).toBe('app');
    expect(repositoryName('app')).toBe('app');
    expect(hasRepositoryOwner('acme/app')).toBe(true);
    expect(hasRepositoryOwner('app')).toBe(false);
  });
});

describe('threadRepository', () => {
  const base = { repository: null, providerProjectName: null, workspacePath: null };

  it('prefers the stored repository', () => {
    expect(threadRepository({ ...base, provider: 'chatgpt', repository: 'Acme/App' }, coding)).toBe('acme/app');
  });

  it('falls back to the project name, then the last folder, for coding sessions only', () => {
    expect(threadRepository({ ...base, provider: 'codex', providerProjectName: 'orders-api' }, coding)).toBe('orders-api');
    expect(threadRepository({ ...base, provider: 'claude_code', workspacePath: '/Users/me/code/webhooks/' }, coding)).toBe('webhooks');
    expect(threadRepository({ ...base, provider: 'claude', providerProjectName: 'Research', workspacePath: '/x/y' }, coding)).toBeNull();
    expect(threadRepository({ ...base, provider: 'codex' }, coding)).toBeNull();
  });
});

describe('groupByRepository', () => {
  const items = (...repos: Array<string | null>) => repos.map((repository, i) => ({ id: i, repository }));
  const group = (list: ReturnType<typeof items>) => groupByRepository(list, (x) => x.repository);

  it('folds a bare name into the single owner/name that ends with it', () => {
    const { groups, ungrouped } = group(items('acme/app', 'app', 'acme/app', null));
    expect(groups).toHaveLength(1);
    expect(groups[0].repository).toBe('acme/app');
    expect(groups[0].items.map((x) => x.id)).toEqual([0, 1, 2]);
    expect(ungrouped.map((x) => x.id)).toEqual([3]);
  });

  it('keeps a bare name apart when two owners share it or none matches', () => {
    const ambiguous = group(items('acme/app', 'other/app', 'app')).groups.map((g) => g.repository).sort();
    expect(ambiguous).toEqual(['acme/app', 'app', 'other/app']);
    const unmatched = group(items('acme/app', 'tool')).groups.map((g) => g.repository).sort();
    expect(unmatched).toEqual(['acme/app', 'tool']);
  });

  it('orders groups by size, then name', () => {
    const { groups } = group(items('b/two', 'a/one', 'c/three', 'c/three', 'b/two', 'c/three'));
    expect(groups.map((g) => [g.repository, g.items.length])).toEqual([
      ['c/three', 3],
      ['b/two', 2],
      ['a/one', 1],
    ]);
  });
});

// ---------------------------------------------------------------- where the repository flows

let dbCounter = 0;
const freshDb = () => new ThreadkeeperDB(`RepositoryTestDB_${++dbCounter}_${Date.now()}`);
const ids = { accountId: 'acct_test', workspaceId: 'ws_test' };
const input = (id: string, extra: Record<string, unknown> = {}) => ({
  threadKey: buildThreadKey({ provider: 'codex', ...ids, sourceConversationId: id, branchId: 'main' }),
  provider: 'codex' as const,
  ...ids,
  sourceConversationId: id,
  branchId: 'main',
  canonicalUrl: '',
  title: `Thread ${id}`,
  createdAt: '2026-10-20T10:00:00.000Z',
  updatedAt: '2026-10-30T10:00:00.000Z',
  coverage: 'full' as const,
  captureSource: 'export_import' as const,
  messages: [{ sourceMessageId: `${id}_0`, role: 'user' as const, content: 'hello', createdAt: null }],
  ...extra,
});

describe('project filing from a repository', () => {
  const settings = normalizeSettings({ autoOrganize: { autoCreateProjects: true } } as never);
  const ctx: OrganizeContext = { collections: [], trusted: new Map(), loadedAt: 0 };
  const conv = (extra: Partial<ConversationRecord>) =>
    ({ threadKey: 't', provider: 'cursor_agents', title: 'x', providerProjectName: null, ...extra }) as ConversationRecord;

  it('uses the repository name when the provider gave no project name, for any coding agent', () => {
    const d = decideProject(conv({ repository: 'acme/web-shop' }), null, 'hello', ctx, settings, new Map());
    expect(d).toMatchObject({ project: 'web-shop', source: 'provider', confidence: 0.9 });
    expect(d?.reason).toBe('New project from repository "web-shop"');
  });

  it('keeps the provider project name when there is one, and ignores a repository on chat threads without it', () => {
    const named = decideProject(conv({ provider: 'codex', providerProjectName: 'Billing', repository: 'acme/web-shop' }), null, '', ctx, settings, new Map());
    expect(named?.project).toBe('Billing');
    const none = decideProject(conv({ repository: null }), null, '', ctx, settings, new Map());
    expect(none).toBeNull();
  });
});

describe('portable bundle', () => {
  it('round-trips repository facts and carries no account data', async () => {
    const db = freshDb();
    await ensureStarterCollectionsAndSettings(db);
    await upsertThread(
      db,
      input('c1', {
        providerProjectName: 'web-shop',
        workspacePath: '/code/web-shop',
        gitBranch: 'fix-1',
        modelSlug: 'gpt-5.5-codex',
        resumeCommand: 'codex resume c1',
        agentLabel: 'Engineer',
        linkedThreadKeys: ['other'],
        repository: 'acme/web-shop',
        pullRequestUrl: 'https://github.com/acme/web-shop/pull/4',
      })
    );
    await db.accounts.put({ id: 'acct_x', realm: 'r' } as never);
    const bundle = await exportPortableBundle(db);
    expect(Object.keys(bundle).sort()).toEqual(['conversations', 'exportedAt', 'format', 'relationships']);
    expect(JSON.stringify(bundle)).not.toContain('acct_x');

    const db2 = freshDb();
    await ensureStarterCollectionsAndSettings(db2);
    await importPortableBundle(db2, bundle);
    const restored = await db2.conversations.get(bundle.conversations[0].conversation.threadKey);
    expect(restored).toMatchObject({
      providerProjectName: 'web-shop',
      workspacePath: '/code/web-shop',
      gitBranch: 'fix-1',
      modelSlug: 'gpt-5.5-codex',
      resumeCommand: 'codex resume c1',
      agentLabel: 'Engineer',
      linkedThreadKeys: ['other'],
      repository: 'acme/web-shop',
      pullRequestUrl: 'https://github.com/acme/web-shop/pull/4',
    });
    expect(await db2.accounts.count()).toBe(0);
  });

  it('drops a repository or pull request in a bundle that does not read as one', async () => {
    const db = freshDb();
    await ensureStarterCollectionsAndSettings(db);
    await upsertThread(db, input('c1', { repository: 'acme/app' }));
    const bundle = await exportPortableBundle(db);
    bundle.conversations[0].conversation.repository = 'not a repo!!';
    bundle.conversations[0].conversation.pullRequestUrl = 'javascript:alert(1)';
    const db2 = freshDb();
    await ensureStarterCollectionsAndSettings(db2);
    await importPortableBundle(db2, bundle);
    const restored = await db2.conversations.get(bundle.conversations[0].conversation.threadKey);
    expect(restored?.repository ?? null).toBeNull();
    expect(restored?.pullRequestUrl ?? null).toBeNull();
  });

  it('writes a repository line in the markdown export', async () => {
    const db = freshDb();
    await ensureStarterCollectionsAndSettings(db);
    const t = input('c1', { repository: 'acme/app', workspacePath: '/code/app' });
    await upsertThread(db, t);
    const conv = (await db.conversations.get(t.threadKey))!;
    const md = exportThreadToMarkdown(conv, [], null);
    expect(md).toContain('- **Repository**: acme/app');
    const without = exportThreadToMarkdown({ ...conv, repository: null }, [], null);
    expect(without).not.toContain('**Repository**');
  });
});

describe('search by repository', () => {
  const conv = (extra: Partial<ConversationRecord>) =>
    ({ threadKey: 't', provider: 'codex', providerProjectName: null, workspacePath: null, ...extra }) as ConversationRecord;

  it('matches the normalized repository exactly, falling back to the folder for coding sessions', () => {
    const scope = { repository: 'Acme/App' };
    expect(matchesScopeFilter(conv({ repository: 'acme/app' }), scope, undefined, false)).toBe(true);
    expect(matchesScopeFilter(conv({ repository: 'acme/other' }), scope, undefined, false)).toBe(false);
    expect(matchesScopeFilter(conv({ workspacePath: '/code/app' }), { repository: 'app' }, undefined, false)).toBe(true);
    expect(matchesScopeFilter(conv({ provider: 'chatgpt', workspacePath: '/code/app' }), { repository: 'app' }, undefined, false)).toBe(false);
    expect(matchesScopeFilter(conv({}), { repository: 'not a repo!!' }, undefined, false)).toBe(false);
  });

  it('finds a thread by its repository text', () => {
    const index = new MemorySearchIndex();
    const c = {
      ...conv({ repository: 'acme/zebra-gateway' }),
      threadKey: 'k1',
      title: 'Something else',
      manualTitleOverride: null,
      tags: [],
      manualNotes: '',
      project: 'P',
      lastCapturedAt: '2026-10-01T00:00:00.000Z',
    } as ConversationRecord;
    index.loadSnapshot({ conversations: [c], messages: [] });
    expect(index.searchLocal('zebra-gateway', undefined, 5).hits.map((h) => h.conversation.threadKey)).toEqual(['k1']);
  });
});

describe('repository edge cases found in review', () => {
  it('does not read a github.com site section as a repository or pull request', () => {
    expect(normalizeRepository('https://github.com/settings/profile')).toBeNull();
    expect(normalizeRepository('https://github.com/features/copilot')).toBeNull();
    expect(normalizePullRequestUrl('https://github.com/pulls/assigned/1')).toBeNull();
    // A person may still type such a name by hand, and other forges have no such sections.
    expect(normalizeRepository('settings/profile')).toBe('settings/profile');
    expect(normalizeRepository('https://gitlab.com/settings/app')).toBe('settings/app');
  });

  it('reads GitLab merge request addresses with the "/-/" segment', () => {
    expect(normalizePullRequestUrl('https://gitlab.com/Acme/App/-/merge_requests/12?tab=diffs')).toBe(
      'https://gitlab.com/acme/app/merge_requests/12'
    );
  });
});
