import 'fake-indexeddb/auto';
import { beforeEach, describe, expect, it } from 'vitest';
import { ThreadStackDB } from '../../src/core/db.js';
import {
  seedSyntheticWorkbenchLibrary,
  seedWorkspaceDemoLibrary,
  WORKSPACE_DEMO_ACCOUNTS,
} from '../../src/core/synthetic-fixtures.js';
import { detectProviderFromUrl, extractConversationIdFromUrl, providerCategory } from '../../src/core/providers.js';
import { groupByRepository, threadRepository } from '../../src/core/repository.js';
import { embedTargetFor } from '../../src/entrypoints/manager/workspace/state.js';
import { primaryAccountId } from '../../src/core/workspace/realms.js';
import { agentStateNeedsYou } from '../../src/core/workspace/types.js';

let n = 0;
let db: ThreadStackDB;
beforeEach(() => {
  db = new ThreadStackDB(`WorkspaceDemoDB_${Date.now()}_${++n}`);
});

const isCoding = (provider: string) => providerCategory(provider) === 'coding_agent';

describe('seedWorkspaceDemoLibrary', () => {
  it('is idempotent', async () => {
    await seedWorkspaceDemoLibrary(db);
    const first = {
      conversations: await db.conversations.orderBy('threadKey').toArray(),
      messages: await db.messages.count(),
      insights: await db.insights.count(),
      accounts: await db.accounts.orderBy('id').toArray(),
    };
    await seedWorkspaceDemoLibrary(db);
    expect(await db.conversations.orderBy('threadKey').toArray()).toEqual(first.conversations);
    expect(await db.messages.count()).toBe(first.messages);
    expect(await db.insights.count()).toBe(first.insights);
    expect(await db.accounts.orderBy('id').toArray()).toEqual(first.accounts);
    expect(first.conversations).toHaveLength(16);
  });

  it('writes believable sessions whose urls map back to their provider and id', async () => {
    await seedWorkspaceDemoLibrary(db);
    const convs = await db.conversations.toArray();
    const counts: Record<string, number> = {};
    for (const c of convs) {
      counts[c.provider] = (counts[c.provider] ?? 0) + 1;
      expect(c.isSyntheticBenchmark).toBe(false);
      expect(['dom_observer', 'network_observer']).toContain(c.captureSource);
      expect(embedTargetFor(c.canonicalUrl)?.provider).toBe(c.provider);
      expect(detectProviderFromUrl(c.canonicalUrl)).toBe(c.provider);
      expect(extractConversationIdFromUrl(c.canonicalUrl)).toBe(c.sourceConversationId);
      expect(c.messageCount).toBeGreaterThanOrEqual(6);
      expect(c.messageCount).toBeLessThanOrEqual(14);
      expect(c.title).not.toMatch(/lorem/i);
    }
    expect(counts).toEqual({
      claude_code: 4, codex: 3, cursor_agents: 1, chatgpt: 2, claude: 2, grok: 1, grok_bot: 1, chatgpt_dots: 1, muse: 1,
    });
  });

  it('spreads the hypestake repository over three providers and two accounts', async () => {
    await seedWorkspaceDemoLibrary(db);
    const convs = await db.conversations.toArray();
    const { groups, ungrouped } = groupByRepository(convs, (c) => threadRepository(c, isCoding));
    const hype = groups.find((g) => g.repository === 'hypestake/hypestake')!;
    expect(hype.items).toHaveLength(5);
    expect(new Set(hype.items.map((c) => c.provider))).toEqual(new Set(['claude_code', 'codex', 'cursor_agents']));
    const claudeAccounts = new Set(hype.items.filter((c) => c.provider === 'claude_code').map((c) => c.accountId));
    expect(claudeAccounts.size).toBe(2);
    expect(claudeAccounts.has('acct_demowork01')).toBe(true);
    const sharedPr = hype.items.filter((c) => c.pullRequestUrl === 'https://github.com/hypestake/hypestake/pull/412');
    expect(sharedPr).toHaveLength(2);
    expect(groups.find((g) => g.repository === 'meridian/daydock')!.items).toHaveLength(3);
    expect(ungrouped).toHaveLength(8);
    expect(convs.filter((c) => c.accountId === 'acct_demowork02')).toHaveLength(1);
    // Primary sessions carry the id the settings bind, not a workspace account id.
    const settings = await db.settings.get('default');
    const primary = convs.find((c) => c.provider === 'claude_code' && c.accountId !== 'acct_demowork01')!;
    expect(primary.accountId).toBe(settings!.boundAccounts.claude_code.accountId);
  });

  it('pins five sessions, three of them on hypestake', async () => {
    await seedWorkspaceDemoLibrary(db);
    const pinned = (await db.conversations.toArray()).filter((c) => c.pinned);
    expect(pinned).toHaveLength(5);
    const onHype = pinned.filter((c) => c.repository === 'hypestake/hypestake');
    expect(onHype).toHaveLength(3);
    expect(new Set(onHype.map((c) => c.accountId)).size).toBe(2);
  });

  it('gives each coding session a run state and an on-device agent run', async () => {
    await seedWorkspaceDemoLibrary(db);
    const coding = (await db.conversations.toArray()).filter((c) => isCoding(c.provider));
    expect(coding).toHaveLength(8);
    expect(new Set(coding.map((c) => c.agentState))).toEqual(
      new Set(['running', 'waiting_permission', 'waiting_answer', 'turn_complete', 'failed'])
    );
    expect(coding.some((c) => agentStateNeedsYou(c.agentState))).toBe(true);
    for (const c of coding) {
      const insight = await db.insights.get(`local|${c.threadKey}`);
      expect(insight?.agentRun, c.title).toBeTruthy();
      expect(insight!.agentRun!.repository).toBe(c.repository);
    }
    const payments = coding.find((c) => c.title.startsWith('Make the payments webhook'))!;
    const run = (await db.insights.get(`local|${payments.threadKey}`))!.agentRun!;
    expect(run.filesChanged).toContain('src/payments/webhooks.ts');
    expect(run.tests.status).toBe('passing');
    expect(run.pullRequests.map((p) => p.url)).toContain('https://github.com/hypestake/hypestake/pull/412');
  });

  it('writes the demo accounts only when missing and leaves jars and kv alone', async () => {
    await seedWorkspaceDemoLibrary(db);
    expect(await db.accounts.count()).toBe(WORKSPACE_DEMO_ACCOUNTS.length);
    expect(await db.accountJars.count()).toBe(0);
    expect(await db.kv.count()).toBe(0);
    expect(await db.accounts.get(primaryAccountId('anthropic'))).toMatchObject({ label: 'Personal', primary: true });
    expect(await db.accounts.get('acct_demowork01')).toMatchObject({ label: 'Work', color: 'peach', mode: 'embedded' });
    expect(await db.accounts.get('acct_demowork02')).toMatchObject({ label: 'Work', color: 'teal', realm: 'openai' });
    // A row the person already edited is not overwritten.
    await db.accounts.update('acct_demowork01', { label: 'Client' });
    await seedWorkspaceDemoLibrary(db);
    expect((await db.accounts.get('acct_demowork01'))!.label).toBe('Client');
  });
});

describe('seedSyntheticWorkbenchLibrary', () => {
  it('still yields exactly its seven threads when run alone', async () => {
    await seedSyntheticWorkbenchLibrary(db);
    const convs = await db.conversations.toArray();
    expect(convs).toHaveLength(7);
  });
});
