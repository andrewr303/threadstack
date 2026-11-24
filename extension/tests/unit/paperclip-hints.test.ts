import 'fake-indexeddb/auto';
import { describe, expect, it } from 'vitest';
import { ThreadStackDB, ensureStarterCollectionsAndSettings } from '../../src/core/db.js';
import { normalizePaperclipSettings } from '../../src/core/schema.js';
import { memoryStateStore, runPaperclipHintSync } from '../../src/core/paperclip/sync.js';
import { FakePaperclip } from './paperclip-fake-server.js';

describe('Paperclip change hints', () => {
  it('resolves a run-only hint through the existing company run step', async () => {
    const db = new ThreadStackDB(`hints-${crypto.randomUUID()}`);
    const server = new FakePaperclip();
    server.addCompany({ id: 'one', name: 'One' });
    server.addIssue({ id: 'first', companyId: 'one', title: 'First' });
    server.addComment('first', { id: 'comment', body: 'Run-only task change' }, false);
    server.addRun('first', { id: 'run-only', agentId: 'agent', status: 'succeeded' });
    const settings = await ensureStarterCollectionsAndSettings(db);
    settings.paperclip = normalizePaperclipSettings({ enabled: true, serverUrl: server.origin });
    const keys = await runPaperclipHintSync({ companyId: 'one', issueIds: [], runIds: ['run-only'] }, { db, settings, fetch: server.fetch });
    expect(keys).toHaveLength(1);
    expect((await db.conversations.get(keys[0]))?.sourceConversationId).toBe('first');
    expect(server.requests.some(request => request.path.includes('/companies/one/heartbeat-runs'))).toBe(true);
    await db.delete();
  });
  it('refreshes only named tasks, including comment-only changes, without altering sync cursors', async () => {
    const db = new ThreadStackDB(`hints-${crypto.randomUUID()}`);
    const server = new FakePaperclip();
    server.addCompany({ id: 'one', name: 'One' });
    server.addIssue({ id: 'first', companyId: 'one', title: 'First' });
    server.addIssue({ id: 'second', companyId: 'one', title: 'Second' });
    server.addComment('first', { id: 'comment', body: 'A new comment' }, false);
    const settings = await ensureStarterCollectionsAndSettings(db);
    settings.paperclip = normalizePaperclipSettings({ enabled: true, serverUrl: server.origin });
    const keys = await runPaperclipHintSync({ companyId: 'one', issueIds: ['first', 'first'] }, { db, settings, fetch: server.fetch });
    expect(keys).toHaveLength(1);
    expect(await db.conversations.count()).toBe(1);
    expect((await db.messages.where('threadKey').equals(keys[0]).toArray()).some(m => m.content.includes('A new comment'))).toBe(true);
    expect(server.requests.some(r => r.path.includes('/issues/second'))).toBe(false);
    await db.delete();
  });

  it('skips a missing task named in a hint and still stores the valid one (REQ-12 F-3)', async () => {
    const db = new ThreadStackDB(`hints-${crypto.randomUUID()}`);
    const server = new FakePaperclip();
    server.addCompany({ id: 'one', name: 'One' });
    server.addIssue({ id: 'first', companyId: 'one', title: 'First' });
    const settings = await ensureStarterCollectionsAndSettings(db);
    settings.paperclip = normalizePaperclipSettings({ enabled: true, serverUrl: server.origin });
    const keys = await runPaperclipHintSync({ companyId: 'one', issueIds: ['deleted-task', 'first'] }, { db, settings, fetch: server.fetch });
    expect(keys).toHaveLength(1);
    expect((await db.conversations.get(keys[0]))?.sourceConversationId).toBe('first');
    await db.delete();
  });

  it('updates "Last synced" after a hint-driven fetch without touching cursors or run marks (REQ-12 UI Layout)', async () => {
    const db = new ThreadStackDB(`hints-${crypto.randomUUID()}`);
    const server = new FakePaperclip();
    server.addCompany({ id: 'one', name: 'One' });
    server.addIssue({ id: 'first', companyId: 'one', title: 'First' });
    const settings = await ensureStarterCollectionsAndSettings(db);
    settings.paperclip = normalizePaperclipSettings({ enabled: true, serverUrl: server.origin });
    const store = memoryStateStore({ serverUrl: server.origin, lastSyncAt: '2026-11-14T00:00:00.000Z', companies: { one: { name: 'One', cursor: '2026-11-13T00:00:00.000Z', cursorIds: ['old'], runMarks: { run: 'mark' } } } });
    const before = JSON.stringify(store.current.companies);
    const now = Date.parse('2026-11-14T12:00:00.000Z');
    await runPaperclipHintSync({ companyId: 'one', issueIds: ['first'] }, { db, settings, fetch: server.fetch, store, now: () => now });
    expect(store.current.lastSyncAt).toBe('2026-11-14T12:00:00.000Z');
    expect(JSON.stringify(store.current.companies)).toBe(before);
    await db.delete();
  });

  it('rejects hints outside selected companies and cross-company issue substitution', async () => {
    const db = new ThreadStackDB(`hints-${crypto.randomUUID()}`);
    const server = new FakePaperclip();
    server.addCompany({ id: 'one', name: 'One' });
    server.addCompany({ id: 'two', name: 'Two' });
    server.addIssue({ id: 'foreign', companyId: 'two', title: 'Foreign' });
    const settings = await ensureStarterCollectionsAndSettings(db);
    settings.paperclip = normalizePaperclipSettings({ enabled: true, serverUrl: server.origin, companyScope: 'selected', companyIds: ['one'] });
    expect(await runPaperclipHintSync({ companyId: 'two', issueIds: ['foreign'] }, { db, settings, fetch: server.fetch })).toEqual([]);
    // REQ-12 F-3 (2026-11-14 repair): a foreign task is skipped like a deleted one, so one bad id cannot
    // abort the rest of a hint; it is still never fetched into the library.
    expect(await runPaperclipHintSync({ companyId: 'one', issueIds: ['foreign'] }, { db, settings, fetch: server.fetch })).toEqual([]);
    expect(await db.conversations.count()).toBe(0);
    expect(server.requests.some(r => r.path.includes('/issues/foreign/comments'))).toBe(false);
    await db.delete();
  });
});
