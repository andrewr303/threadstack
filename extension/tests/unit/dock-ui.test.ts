// Threadkeeper manager UI for the Still (Sidebar Dock) link: page client, pure helpers, the
// Settings panel, Send to Still (dialog, bulk bar), the In Still badge, and DOCK_SYNC_NOW after
// page writes.
import 'fake-indexeddb/auto';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { upsertThread, updateManualThreadFields } from '../../src/core/db.js';
import { DEFAULT_DOCK_PREFS } from '../../src/core/schema.js';
import type { DockStateView } from '../../src/core/dock/external.js';
import {
  NEW_COLLECTION,
  chunk,
  citedSourceKeys,
  configureDockClient,
  describeSendOutcome,
  describeSyncPrefs,
  dockErrorText,
  dockStatusSummary,
  dockSyncNow,
  getDockState,
  getStillStatus,
  invalidateStillStatus,
  resetDockClient,
  sendThreadsToStill,
  sortCollections,
  stillBadgeText,
  stillTargetFromChoice,
  targetLabel,
} from '../../src/entrypoints/manager/dock.js';
import { InStillBadge, SendToStillDialog, SidebarDockPanel } from '../../src/entrypoints/manager/SidebarDock.js';
import { BulkActions, bulkPatchAffectsPrivacy } from '../../src/entrypoints/manager/BulkActions.js';
import { sharedDb } from '../../src/entrypoints/manager/shared.js';
import { STILL_ID, TK_ID, fakeStill, harness, pairDirect, seed, thread } from './dock-helpers.js';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

type Sent = Record<string, unknown>;

/** A scripted worker: records every DOCK_* message and answers by type. */
function fakeWorker(handlers: Partial<Record<string, (m: Sent) => unknown>> = {}) {
  const sent: Sent[] = [];
  const send = async (m: Record<string, unknown>) => {
    sent.push(m);
    const h = handlers[m.type as string];
    return h ? h(m) : { ok: true };
  };
  configureDockClient({ send });
  return { sent, of: (type: string) => sent.filter((m) => m.type === type) };
}

function stateView(patch: Partial<DockStateView> = {}): DockStateView {
  return {
    ownId: TK_ID,
    paired: false,
    pairedId: '',
    pairedName: '',
    pairedAt: '',
    configured: false,
    prefs: { ...DEFAULT_DOCK_PREFS },
    allowSearch: true,
    shareTranscripts: true,
    allowRemoteModels: false,
    blockedIds: [],
    capabilities: [],
    pending: null,
    queued: 0,
    tracked: 0,
    sent: 0,
    lastPushAt: '',
    lastError: '',
    lastErrorAt: '',
    ...patch,
  };
}

const PAIRED = stateView({
  paired: true,
  pairedId: STILL_ID,
  pairedName: 'Still',
  pairedAt: '2026-11-01T12:00:00.000Z',
  configured: true,
  prefs: { scope: 'projects', projects: ['Daydock', 'HypeStake'], providers: ['chatgpt', 'claude_code'], transcripts: true, autoUpdate: true },
  sent: 12,
  tracked: 2,
  queued: 1,
  lastPushAt: '2026-11-01T12:05:00.000Z',
});

const PENDING = {
  senderId: STILL_ID,
  requestId: 'req-1',
  appName: 'Still',
  appVersion: '2.1.0',
  codeHash: 'x',
  at: '2026-11-01T12:00:00.000Z',
  expiresAt: '2026-11-01T12:10:00.000Z',
  expiresInMs: 600_000,
  granted: false,
};

let container: HTMLDivElement;
let root: Root;

async function render(el: React.ReactElement) {
  await act(async () => root.render(el));
  // Let effects' promises settle.
  await act(async () => {
    await new Promise((r) => setTimeout(r, 0));
  });
}

async function flush() {
  await act(async () => {
    await new Promise((r) => setTimeout(r, 0));
  });
}

function buttonByText(text: string | RegExp): HTMLButtonElement | undefined {
  return Array.from(container.querySelectorAll('button')).find((b) =>
    typeof text === 'string' ? b.textContent?.trim() === text : text.test(b.textContent ?? '')
  );
}

async function click(el: Element | undefined) {
  if (!el) throw new Error('element not found');
  await act(async () => {
    (el as HTMLElement).click();
  });
  await flush();
}

async function waitFor(check: () => boolean, ms = 2000) {
  const end = Date.now() + ms;
  while (!check()) {
    if (Date.now() > end) throw new Error('timed out');
    await act(async () => {
      await new Promise((r) => setTimeout(r, 10));
    });
  }
}

async function setValue(el: HTMLInputElement | HTMLSelectElement, value: string) {
  await act(async () => {
    const proto = el instanceof HTMLSelectElement ? HTMLSelectElement.prototype : HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(proto, 'value')!.set!.call(el, value);
    el.dispatchEvent(new Event(el instanceof HTMLSelectElement ? 'change' : 'input', { bubbles: true }));
  });
  await flush();
}

beforeEach(() => {
  resetDockClient();
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  resetDockClient();
});

// ---------------------------------------------------------------------------

describe('pure helpers', () => {
  it('maps the target picker to a DOCK_SEND target', () => {
    expect(stillTargetFromChoice('', '')).toEqual({ ok: true, target: null });
    expect(stillTargetFromChoice('col_123', '')).toEqual({ ok: true, target: { collectionId: 'col_123' } });
    expect(stillTargetFromChoice(NEW_COLLECTION, '  Pricing   research ')).toEqual({ ok: true, target: { collectionName: 'Pricing research' } });
    expect(stillTargetFromChoice(NEW_COLLECTION, '   ')).toEqual({ ok: false, error: 'Name the new collection.' });
    expect(stillTargetFromChoice('bad id!', '').ok).toBe(false);
    const long = stillTargetFromChoice(NEW_COLLECTION, 'x'.repeat(300));
    expect(long.ok && long.target && 'collectionName' in long.target && long.target.collectionName.length).toBe(120);
  });

  it('describes a send, including private and missing threads', () => {
    expect(describeSendOutcome({ ok: true, queued: 3, skipped: [] }, 'Still')).toEqual({
      ok: true,
      text: 'Sending 3 threads to Still. They appear in Still in a moment.',
    });
    const mixed = describeSendOutcome(
      { ok: true, queued: 1, skipped: [{ threadKey: 'a', reason: 'local_only' }, { threadKey: 'b', reason: 'missing' }] },
      '“Research” in Still'
    );
    expect(mixed.ok).toBe(true);
    expect(mixed.text).toContain('Sending 1 thread to “Research” in Still.');
    expect(mixed.text).toContain('1 local-only thread stayed here: private threads are never shared.');
    expect(mixed.text).toContain('1 thread no longer exists.');
    const none = describeSendOutcome({ ok: true, queued: 0, skipped: [{ threadKey: 'a', reason: 'local_only' }] }, 'Still');
    expect(none.ok).toBe(false);
    expect(none.text).toMatch(/^Nothing was sent\./);
    expect(describeSendOutcome({ ok: false, error: 'Connect Still first.' }, 'Still')).toEqual({ ok: false, text: 'Connect Still first.' });
  });

  it('labels targets and badges', () => {
    const cols = [{ id: 'c1', name: 'Research', parentId: 'p', path: 'AI chats / Research', icon: '', color: '' }];
    expect(targetLabel('', '', cols)).toBe('Still');
    expect(targetLabel('c1', '', cols)).toBe('“AI chats / Research” in Still');
    expect(targetLabel(NEW_COLLECTION, ' Pricing ', cols)).toBe('the new collection “Pricing” in Still');
    const base = { itemId: 'chat_tk_x', collectionId: '', collectionName: '', trashed: false, hasTranscript: true, transcriptRevision: 3 };
    expect(stillBadgeText(base)).toBe('In Still · Inbox');
    expect(stillBadgeText({ ...base, collectionId: 'c1', collectionName: 'Research' })).toBe('In Still · Research');
    expect(stillBadgeText({ ...base, trashed: true, collectionName: 'Research' })).toBe('In Still · Trash');
  });

  it('sorts collections by path, numerically and case-insensitively', () => {
    const c = (id: string, path: string) => ({ id, name: path, parentId: '', path, icon: '', color: '' });
    expect(sortCollections([c('3', 'b'), c('1', 'Project 10'), c('2', 'project 9'), c('4', 'A')]).map((x) => x.id)).toEqual(['4', '3', '2', '1']);
  });

  it('summarizes the link state', () => {
    expect(dockStatusSummary(null)).toEqual({ short: 'Off', long: 'Not connected' });
    expect(dockStatusSummary(stateView({ pending: PENDING }))).toMatchObject({ short: 'Request', tone: 'danger' });
    expect(dockStatusSummary(stateView({ pending: { ...PENDING, granted: true } })).short).toBe('Connecting');
    expect(dockStatusSummary({ ...PAIRED, configured: false }).long).toBe('Connected to Still; it has not chosen what to sync yet');
    expect(dockStatusSummary(PAIRED)).toEqual({ short: 'Connected', long: 'Connected to Still' });
  });

  it('reads back what Still asked to sync', () => {
    expect(describeSyncPrefs(PAIRED.prefs, false, true)).toEqual([
      { label: 'What syncs', value: 'Nothing yet. Still chooses this when you press Start syncing there.' },
    ]);
    const rows = Object.fromEntries(describeSyncPrefs(PAIRED.prefs, true, true).map((r) => [r.label, r.value]));
    expect(rows['What syncs']).toBe('Threads in 2 projects: Daydock, HypeStake');
    expect(rows.Providers).toBe('ChatGPT, Claude Code');
    expect(rows.Content).toBe('Summaries and full transcripts');
    expect(Object.fromEntries(describeSyncPrefs(PAIRED.prefs, true, false).map((r) => [r.label, r.value])).Content).toBe(
      'Summaries only (transcript sharing is off here)'
    );
    const many = describeSyncPrefs({ ...PAIRED.prefs, scope: 'projects', projects: ['a', 'b', 'c', 'd', 'e', 'f', 'g'], providers: [] }, true, true);
    expect(many[0].value).toBe('Threads in 7 projects: a, b, c, d, e and 2 more');
    expect(many[1].value).toBe('All providers');
    expect(describeSyncPrefs({ ...PAIRED.prefs, scope: 'all' }, true, true)[0].value).toBe('Every thread');
    expect(describeSyncPrefs({ ...PAIRED.prefs, scope: 'manual', autoUpdate: false }, true, true).map((r) => r.value)).toEqual([
      'Only threads you send or Still adds',
      'ChatGPT, Claude Code',
      'Summaries and full transcripts',
      'Only when a thread is sent again',
    ]);
  });

  it('turns worker and protocol errors into plain words', () => {
    expect(dockErrorText('Connect Still first.')).toEqual({ text: 'Connect Still first.' });
    expect(dockErrorText({ code: 'unreachable', message: 'x' }).text).toMatch(/not responding/);
    expect(dockErrorText({ code: 'busy', message: 'x' }).text).toBe('Still is busy. Try again in a moment.');
    expect(dockErrorText({ code: 'bad_request', message: 'Bad collection' })).toEqual({ code: 'bad_request', text: 'Bad collection' });
    expect(dockErrorText(undefined).text).toBe('That did not work.');
  });

  it('picks the cited Ask sources, or all of them', () => {
    expect(citedSourceKeys('See [T2] and [T1], again [T2]; [T9] is out of range.', ['a', 'b', 'c'])).toEqual(['b', 'a']);
    expect(citedSourceKeys('', ['a', 'b'])).toEqual(['a', 'b']);
  });

  it('marks bulk edits that change what may be shared', () => {
    expect(bulkPatchAffectsPrivacy({ cloudExcluded: true })).toBe(true);
    expect(bulkPatchAffectsPrivacy({ project: 'Personal' })).toBe(true);
    expect(bulkPatchAffectsPrivacy({ pinned: true })).toBe(false);
    expect(bulkPatchAffectsPrivacy({ workflowState: 'done' })).toBe(false);
    expect(chunk([1, 2, 3, 4, 5], 2)).toEqual([[1, 2], [3, 4], [5]]);
  });
});

// ---------------------------------------------------------------------------

describe('page client', () => {
  it('attaches the overlay handshake token and reports failures without throwing', async () => {
    const w = fakeWorker({ DOCK_GET_STATE: () => ({ ok: true, state: PAIRED }) });
    configureDockClient({ handshakeToken: 'tok_1234567890abcdef' });
    expect((await getDockState())?.pairedId).toBe(STILL_ID);
    expect(w.sent[0]).toEqual({ type: 'DOCK_GET_STATE', handshakeToken: 'tok_1234567890abcdef' });

    configureDockClient({
      send: async () => {
        throw new Error('Receiving end does not exist');
      },
    });
    expect(await getDockState()).toBeNull();
    const res = await sendThreadsToStill(['k'], null);
    expect(res.ok).toBe(false);
    expect(!res.ok && res.error).toMatch(/background did not answer/);
  });

  it('DOCK_SYNC_NOW: batches keys, carries the privacy flag, and stays quiet once known unpaired', async () => {
    const w = fakeWorker({ DOCK_GET_STATE: () => ({ ok: true, state: PAIRED }) });
    dockSyncNow([]);
    expect(w.sent).toHaveLength(0);
    dockSyncNow([], { privacy: true });
    const keys = Array.from({ length: 4500 }, (_, i) => `k${i}`);
    dockSyncNow([...keys, 'k1']);
    await flush();
    const syncs = w.of('DOCK_SYNC_NOW');
    expect(syncs.map((m) => (m.threadKeys as string[]).length)).toEqual([0, 2000, 2000, 500]);
    expect(syncs[0].privacy).toBe(true);
    expect(syncs[1].privacy).toBe(false);

    configureDockClient({ send: async (m) => (m.type === 'DOCK_GET_STATE' ? { ok: true, state: stateView() } : { ok: true }) });
    await getDockState();
    const after = fakeWorker();
    dockSyncNow(['a'], { privacy: true });
    expect(after.sent).toHaveLength(0);
  });

  it('sends in batches of 500 and adds up the answers', async () => {
    const w = fakeWorker({
      DOCK_SEND: (m) => {
        const keys = m.threadKeys as string[];
        return { ok: true, queued: keys.length - 1, skipped: [{ threadKey: keys[0], reason: 'local_only' }] };
      },
    });
    const keys = Array.from({ length: 1200 }, (_, i) => `k${i}`);
    const res = await sendThreadsToStill(keys, { collectionName: 'Pricing' });
    expect(w.of('DOCK_SEND').map((m) => (m.threadKeys as string[]).length)).toEqual([500, 500, 200]);
    expect(w.of('DOCK_SEND')[0].target).toEqual({ collectionName: 'Pricing' });
    expect(res).toEqual({ ok: true, queued: 1197, skipped: [{ threadKey: 'k0', reason: 'local_only' }, { threadKey: 'k500', reason: 'local_only' }, { threadKey: 'k1000', reason: 'local_only' }] });

    const w2 = fakeWorker();
    await sendThreadsToStill(['a'], null);
    expect('target' in w2.of('DOCK_SEND')[0]).toBe(false);
  });

  it('caches In Still status per thread, shares in-flight requests and forgets on invalidate', async () => {
    const status = { itemId: 'chat_tk_1', collectionId: 'c1', collectionName: 'Research', trashed: false, hasTranscript: true, transcriptRevision: 1 };
    const w = fakeWorker({ DOCK_STATUS_FOR: (m) => ({ ok: true, chats: (m.threadKeys as string[])[0] === 'a' ? { a: status } : {} }) });
    const [one, two] = await Promise.all([getStillStatus('a'), getStillStatus('a')]);
    expect(one).toEqual(status);
    expect(two).toEqual(status);
    expect(await getStillStatus('b')).toBeNull();
    expect(await getStillStatus('a')).toEqual(status);
    expect(w.of('DOCK_STATUS_FOR')).toHaveLength(2);
    invalidateStillStatus(['a']);
    await getStillStatus('a');
    expect(w.of('DOCK_STATUS_FOR')).toHaveLength(3);
    // Expired after two minutes.
    await getStillStatus('a', Date.now() + 3 * 60_000);
    expect(w.of('DOCK_STATUS_FOR')).toHaveLength(4);

    configureDockClient({ send: async () => ({ ok: false, error: { code: 'unreachable', message: 'x' } }) });
    expect(await getStillStatus('z')).toBeUndefined();
  });

  it('speaks the real DockService: Send to Still queues shareable threads and skips private ones', async () => {
    const h = await harness({ still: fakeStill() });
    await pairDirect(h, { scope: 'manual' });
    const open = await seed(h.db, thread('open1', 'Webhook retries', [['user', 'How do I retry?'], ['assistant', 'Use backoff.']]));
    const secret = await seed(h.db, thread('secret1', 'Private', [['user', 'secret'], ['assistant', 'ok']]));
    await updateManualThreadFields(h.db, secret, { cloudExcluded: true });
    // The same routing background.ts does for these message types.
    configureDockClient({
      send: async (m) => {
        switch (m.type) {
          case 'DOCK_SEND':
            return h.dock.sendThreads(m.threadKeys, m.target);
          case 'DOCK_GET_STATE':
            return { ok: true, state: await h.dock.getState() };
          case 'DOCK_STATUS_FOR':
            return h.dock.statusFor(m.threadKeys);
          default:
            return { ok: false, error: 'unexpected' };
        }
      },
    });
    const res = await sendThreadsToStill([open, secret, 'missing:key'], { collectionName: 'Webhooks' });
    expect(res).toEqual({
      ok: true,
      queued: 1,
      skipped: [
        { threadKey: secret, reason: 'local_only' },
        { threadKey: 'missing:key', reason: 'missing' },
      ],
    });
    const row = await h.db.dockOutbox.get(open);
    expect(row?.op).toBe('upsert');
    const state = await getDockState();
    expect(state?.paired).toBe(true);
    expect(state?.tracked).toBe(1);
    // The private thread is never even named to Still.
    expect(await getStillStatus(secret)).toBeNull();
    expect(h.still.of('chats.status').some((c) => (c.message.threadKeys as string[]).includes(secret))).toBe(false);
  });
});

// ---------------------------------------------------------------------------

describe('Settings → Sidebar Dock', () => {
  it('not connected: says how to connect from Still and shows this Threadkeeper’s ID', async () => {
    fakeWorker();
    await render(React.createElement(SidebarDockPanel, { state: stateView(), loaded: true, onRefresh: () => undefined, framed: false }));
    expect(container.querySelector('.tk-dock-status')?.textContent).toContain('Not connected');
    expect(container.textContent).toContain('Settings → Integrations → AI chat threads → Find Threadkeeper');
    expect(container.querySelector('.tk-dock-id')?.textContent).toBe('aaaa bbbb cccc dddd aaaa bbbb cccc dddd');
    expect(buttonByText('Copy ID')).toBeTruthy();
    expect(buttonByText('Disconnect…')).toBeUndefined();
  });

  it('a waiting request is reviewed in the consent window, never allowed inline', async () => {
    const w = fakeWorker();
    let refreshed = 0;
    await render(
      React.createElement(SidebarDockPanel, {
        state: stateView({ pending: PENDING }),
        loaded: true,
        onRefresh: () => {
          refreshed += 1;
        },
        framed: false,
        now: Date.parse('2026-11-01T12:03:00.000Z'),
      })
    );
    expect(container.textContent).toContain('“Still” is asking to connect');
    expect(container.textContent).toContain('expires in 7 minutes');
    expect(container.textContent).toContain('abcd efgh ijkl mnop abcd efgh ijkl mnop');
    expect(buttonByText('Allow')).toBeUndefined();
    expect(buttonByText('Deny')).toBeUndefined();
    await click(buttonByText('Review request…'));
    expect(w.of('DOCK_OPEN_CONSENT')).toHaveLength(1);
    expect(w.of('DOCK_DECIDE')).toHaveLength(0);
    expect(refreshed).toBe(1);
  });

  it('framed in a website (overlay): no review, toggles or disconnect, and it says why', async () => {
    fakeWorker();
    await render(React.createElement(SidebarDockPanel, { state: { ...PAIRED, pending: PENDING }, loaded: true, onRefresh: () => undefined, framed: true }));
    expect(container.querySelector('.tk-dock-framed')?.textContent).toContain('open Threadkeeper in its own window');
    expect(buttonByText('Review request…')).toBeUndefined();
    expect(buttonByText('Disconnect…')).toBeUndefined();
    expect(buttonByText('Resync')).toBeUndefined();
    const boxes = Array.from(container.querySelectorAll<HTMLInputElement>('input[type="checkbox"]'));
    expect(boxes).toHaveLength(3);
    expect(boxes.every((b) => b.disabled)).toBe(true);
  });

  it('connected: shows the pairing, what Still asked for, toggles options and disconnects after a confirm', async () => {
    const w = fakeWorker({
      DOCK_SET_OPTIONS: () => ({ ok: true, state: PAIRED }),
      DOCK_RESYNC: () => ({ ok: true, queued: 4 }),
    });
    await render(React.createElement(SidebarDockPanel, { state: PAIRED, loaded: true, onRefresh: () => undefined, framed: false }));
    expect(container.textContent).toContain('Connected to Still');
    expect(container.textContent).toContain('12 threads sent · 2 threads added by hand or by Still · 1 waiting to go');
    expect(container.textContent).toContain('Threads in 2 projects: Daydock, HypeStake');

    const remote = Array.from(container.querySelectorAll<HTMLLabelElement>('label.tk-toggle')).find((l) =>
      l.textContent?.includes('embedding and rerank providers')
    )!;
    const box = remote.querySelector('input')!;
    expect(box.checked).toBe(false);
    await click(box);
    expect(w.of('DOCK_SET_OPTIONS')).toEqual([{ type: 'DOCK_SET_OPTIONS', allowRemoteModels: true }]);

    await click(buttonByText('Resync'));
    expect(container.querySelector('.tk-settings-result')?.textContent).toBe('Offering 4 threads to Still again.');

    await click(buttonByText('Disconnect…'));
    expect(w.of('DOCK_UNPAIR')).toHaveLength(0);
    expect(container.textContent).toContain('Still keeps the chats it has');
    await click(buttonByText('Disconnect'));
    expect(w.of('DOCK_UNPAIR')).toHaveLength(1);
    expect(container.querySelector('.tk-settings-result')?.textContent).toBe('Disconnected from Still.');
  });

  it('shows the worker’s refusal (e.g. from a framed page) as an error line', async () => {
    fakeWorker({ DOCK_UNBLOCK: () => ({ ok: false, error: 'Open Threadkeeper in its own window to do this.' }) });
    await render(
      React.createElement(SidebarDockPanel, { state: stateView({ blockedIds: [STILL_ID] }), loaded: true, onRefresh: () => undefined, framed: false })
    );
    expect(container.textContent).toContain('Blocked extensions');
    await click(buttonByText('Unblock'));
    const line = container.querySelector('.tk-settings-result');
    expect(line?.getAttribute('data-ok')).toBe('false');
    expect(line?.textContent).toBe('Open Threadkeeper in its own window to do this.');
  });
});

// ---------------------------------------------------------------------------

describe('Send to Still', () => {
  const COLLECTIONS = [
    { id: 'c2', name: 'Research', parentId: 'c1', path: 'AI chats / Research', icon: '', color: '' },
    { id: 'c1', name: 'AI chats', parentId: '', path: 'AI chats', icon: '', color: '' },
  ];

  it('the dialog lists Still’s collections and can send to a new one', async () => {
    const w = fakeWorker({
      DOCK_COLLECTIONS: () => ({ ok: true, collections: COLLECTIONS }),
      DOCK_SEND: (m) => ({ ok: true, queued: (m.threadKeys as string[]).length, skipped: [] }),
    });
    const ref = { current: null as HTMLDialogElement | null };
    const done: string[] = [];
    await render(
      React.createElement(SendToStillDialog, {
        dialogRef: ref,
        request: { threadKeys: ['k1', 'k2'], label: '2 search results' },
        onClosed: () => undefined,
        onDone: (m: string) => done.push(m),
      })
    );
    expect(container.querySelector('h2')?.textContent).toBe('Send 2 search results to Still');
    const select = container.querySelector<HTMLSelectElement>('select')!;
    expect(Array.from(select.options).map((o) => o.textContent)).toEqual([
      "Still's default placement",
      'AI chats',
      'AI chats / Research',
      'New collection…',
    ]);
    await setValue(select, NEW_COLLECTION);
    await click(buttonByText('Send 2'));
    expect(w.of('DOCK_SEND')).toHaveLength(0);
    expect(container.querySelector('.tk-settings-result')?.textContent).toBe('Name the new collection.');

    await setValue(container.querySelector<HTMLInputElement>('input[aria-label="Name of the new Still collection"]')!, 'Webhooks');
    await click(buttonByText('Send 2'));
    expect(w.of('DOCK_SEND')[0]).toMatchObject({ threadKeys: ['k1', 'k2'], target: { collectionName: 'Webhooks' } });
    expect(done[0]).toBe('Sending 2 threads to the new collection “Webhooks” in Still. They appear in Still in a moment.');
  });

  it('falls back to Still’s default placement when its collections cannot be read', async () => {
    const w = fakeWorker({
      DOCK_COLLECTIONS: () => ({ ok: false, error: { code: 'unreachable', message: 'no' } }),
      DOCK_SEND: () => ({ ok: true, queued: 1, skipped: [] }),
    });
    await render(
      React.createElement(SendToStillDialog, {
        dialogRef: { current: null },
        request: { threadKeys: ['k1'], label: 'this thread' },
        onClosed: () => undefined,
        onDone: () => undefined,
      })
    );
    expect(container.textContent).toContain("You can still send to Still's default placement.");
    await click(buttonByText('Send'));
    expect('target' in w.of('DOCK_SEND')[0]).toBe(false);
  });

  it('the In Still badge shows where Still keeps the thread, and nothing when it does not', async () => {
    fakeWorker({
      DOCK_STATUS_FOR: (m) =>
        (m.threadKeys as string[])[0] === 'held'
          ? { ok: true, chats: { held: { itemId: 'chat_tk_1', collectionId: 'c2', collectionName: 'Research', trashed: false, hasTranscript: true, transcriptRevision: 2 } } }
          : { ok: true, chats: {} },
    });
    await render(React.createElement(InStillBadge, { threadKey: 'held', paired: true }));
    expect(container.querySelector('.tk-in-still')?.textContent).toBe('In Still · Research');
    await render(React.createElement(InStillBadge, { threadKey: 'other', paired: true }));
    expect(container.querySelector('.tk-in-still')).toBeNull();
    await render(React.createElement(InStillBadge, { threadKey: 'held', paired: false }));
    expect(container.querySelector('.tk-in-still')).toBeNull();
  });
});

// ---------------------------------------------------------------------------

describe('bulk bar', () => {
  const ACCOUNT = { accountId: 'acct_ui', workspaceId: 'ws_ui' };
  async function seedShared(id: string): Promise<string> {
    const input = { ...thread(id, `Thread ${id}`, [['user', `Question ${id}`], ['assistant', `Answer ${id}`]]), ...ACCOUNT };
    input.threadKey = `chatgpt:${ACCOUNT.accountId}:${ACCOUNT.workspaceId}:${id}:main`;
    await upsertThread(sharedDb, input);
    return input.threadKey;
  }

  function bar(keys: string[], stillPaired: boolean, changed: string[]) {
    return React.createElement(BulkActions, {
      selectedKeys: new Set(keys),
      viewKeys: keys,
      projectNames: ['General research', 'Personal'],
      selectAllRef: { current: null },
      deleteDialogRef: { current: null },
      canEdit: () => true,
      onSelectionChange: () => undefined,
      onChanged: async (m: string) => {
        changed.push(m);
      },
      onAnnounce: (m: string) => changed.push(m),
      onDialogClosed: () => undefined,
      stillPaired,
    });
  }

  it('offers Send to Still only when connected, and sends the selection to the chosen collection', async () => {
    const w = fakeWorker({
      DOCK_COLLECTIONS: () => ({ ok: true, collections: [{ id: 'c1', name: 'AI chats', parentId: '', path: 'AI chats', icon: '', color: '' }] }),
      DOCK_SEND: (m) => ({ ok: true, queued: (m.threadKeys as string[]).length, skipped: [] }),
    });
    const changed: string[] = [];
    await render(bar(['k1', 'k2'], false, changed));
    expect(container.querySelector('optgroup[label="Share"]')).toBeNull();

    await render(bar(['k1', 'k2'], true, changed));
    const action = container.querySelector<HTMLSelectElement>('select[aria-label="Action for the selected threads"]')!;
    await setValue(action, 'send_still');
    const target = container.querySelector<HTMLSelectElement>('select[aria-label="Where Still puts the threads"]')!;
    expect(Array.from(target.options).map((o) => o.value)).toEqual(['', 'c1', NEW_COLLECTION]);
    await setValue(target, 'c1');
    await click(buttonByText('Send'));
    expect(w.of('DOCK_SEND')[0]).toMatchObject({ threadKeys: ['k1', 'k2'], target: { collectionId: 'c1' } });
    expect(changed.at(-1)).toBe('Sending 2 threads to “AI chats” in Still. They appear in Still in a moment.');
  });

  it('local-only and move edits tell the worker at once (DOCK_SYNC_NOW with privacy)', async () => {
    const a = await seedShared('bulk_a');
    const b = await seedShared('bulk_b');
    const w = fakeWorker();
    const changed: string[] = [];
    await render(bar([a, b], true, changed));
    const action = container.querySelector<HTMLSelectElement>('select[aria-label="Action for the selected threads"]')!;
    await setValue(action, 'local_on');
    await click(buttonByText('Apply'));
    await waitFor(() => w.of('DOCK_SYNC_NOW').length > 0);
    const syncs = w.of('DOCK_SYNC_NOW');
    expect(syncs).toHaveLength(1);
    expect(syncs[0].privacy).toBe(true);
    expect([...(syncs[0].threadKeys as string[])].sort()).toEqual([a, b].sort());
    expect((await sharedDb.conversations.get(a))?.cloudExcluded).toBe(true);

    await waitFor(() => Boolean(buttonByText('Apply') && !buttonByText('Apply')!.disabled));
    await setValue(action, 'pin');
    await click(buttonByText('Apply'));
    await waitFor(() => w.of('DOCK_SYNC_NOW').length > 1);
    expect(w.of('DOCK_SYNC_NOW')[1].privacy).toBe(false);

    // Undo can restore any field, including local-only and project: always the privacy path.
    await waitFor(() => Boolean(buttonByText('Undo')));
    await click(buttonByText('Undo'));
    await waitFor(() => w.of('DOCK_SYNC_NOW').length > 2);
    expect(w.of('DOCK_SYNC_NOW')[2]).toMatchObject({ privacy: true });
  });
});
