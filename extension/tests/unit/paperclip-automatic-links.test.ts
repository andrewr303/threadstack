import 'fake-indexeddb/auto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ensureStarterCollectionsAndSettings } from '../../src/core/db.js';
import { buildAutomaticSessionLinks, buildSessionInventory } from '../../src/core/paperclip/bridge-query.js';
import { buildIssueThread } from '../../src/core/paperclip/mapper.js';
import { freshDb, seed, thread } from './dock-helpers.js';

const databases: ReturnType<typeof freshDb>[] = [];
afterEach(async () => { for (const db of databases.splice(0)) await db.delete(); });
async function harness() {
  const db = freshDb(); databases.push(db);
  const settings = await ensureStarterCollectionsAndSettings(db); settings.paperclip.serverUrl = 'http://127.0.0.1:3100'; await db.settings.put(settings);
  const codingKey = await seed(db, thread('coding', 'Coding session', [['user', 'coding']], { provider: 'claude_code', canonicalUrl: 'https://claude.ai/code/session_coding' }));
  const task = (id: string, companyId?: string) => thread(id, 'PRIVATE TASK TITLE SHOULD NEVER BE SENT', [['user', 'PRIVATE TASK CONTENT']], { provider: 'paperclip', canonicalUrl: `http://127.0.0.1:3100/SAMEPREFIX/issues/${id}`, linkedThreadKeys: [codingKey], ...(companyId ? { paperclipCompanyId: companyId } : {}) });
  return { db, settings, codingKey, task };
}

describe('Paperclip automatic session links', () => {
  it('projects only verified same-company IDs, without inventorying Paperclip tasks or text', async () => {
    const h = await harness(); await seed(h.db, h.task('task-a', 'a')); await seed(h.db, h.task('task-b', 'b'));
    const links = await buildAutomaticSessionLinks(h.db, 'a');
    expect(links).toEqual([{ issueId: 'task-a', threadKey: h.codingKey }]);
    expect(JSON.stringify(links)).not.toContain('task-b'); expect(JSON.stringify(links)).not.toContain('PRIVATE');
    expect((await buildSessionInventory(h.db)).every(row => row.provider !== 'paperclip')).toBe(true);
  });
  it('never uses the route prefix or title to guess the company of a legacy task', async () => {
    const h = await harness(); const taskKey = await seed(h.db, h.task('legacy'));
    expect(await buildAutomaticSessionLinks(h.db, 'a')).toEqual([]);
    const verifyIssueCompany = vi.fn(async () => 'b');
    expect(await buildAutomaticSessionLinks(h.db, 'a', { verifyIssueCompany })).toEqual([]);
    expect(verifyIssueCompany).toHaveBeenCalledWith('legacy');
    expect((await h.db.conversations.get(taskKey))?.paperclipCompanyId).toBe('b');
    expect(await buildAutomaticSessionLinks(h.db, 'b')).toEqual([{ issueId: 'legacy', threadKey: h.codingKey }]);
  });
  it('excludes private tasks, private coding sessions, unknown sessions and other-server tasks', async () => {
    const h = await harness(); const taskKey = await seed(h.db, h.task('private-task', 'a'));
    await h.db.conversations.update(taskKey, { cloudExcluded: true });
    expect(await buildAutomaticSessionLinks(h.db, 'a')).toEqual([]);
    await h.db.conversations.update(taskKey, { cloudExcluded: false });
    await h.db.conversations.update(h.codingKey, { cloudExcluded: true });
    expect(await buildAutomaticSessionLinks(h.db, 'a')).toEqual([]);
    await h.db.conversations.update(h.codingKey, { cloudExcluded: false });
    await h.db.conversations.update(taskKey, { canonicalUrl: 'http://127.0.0.1:3200/SAMEPREFIX/issues/private-task' });
    const verifyIssueCompany = vi.fn(async () => 'a');
    expect(await buildAutomaticSessionLinks(h.db, 'a', { verifyIssueCompany })).toEqual([]); expect(verifyIssueCompany).not.toHaveBeenCalled();
  });
  it('records the server-verified company in newly mapped task threads', async () => {
    const h = await harness();
    const mapped = buildIssueThread({ serverUrl: h.settings.paperclip.serverUrl, company: { id: 'a', name: 'A', issuePrefix: 'SAMEPREFIX' }, issue: { id: 'task', companyId: 'a', title: 'Task' }, comments: [], runs: [], agents: new Map(), account: h.settings.boundAccounts.paperclip, linkedThreadKeys: [h.codingKey] });
    expect(mapped.paperclipCompanyId).toBe('a');
    const key = await seed(h.db, mapped); expect((await h.db.conversations.get(key))?.paperclipCompanyId).toBe('a');
    expect(await buildAutomaticSessionLinks(h.db, 'a')).toEqual([{ issueId: 'task', threadKey: h.codingKey }]);
  });
});
