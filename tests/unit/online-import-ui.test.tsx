import 'fake-indexeddb/auto';
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ImportDialog } from '../../src/entrypoints/manager/ImportDialog.js';
import { DEFAULT_SETTINGS } from '../../src/core/schema.js';
import { EMPTY_SYNC_STATE, type SyncProviderState, type SyncState } from '../../src/core/history-sync.js';
import { ImportProgress } from '../../src/entrypoints/manager/ImportProgress.js';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
afterEach(() => vi.unstubAllGlobals());

describe('online import menu', () => {
  it('starts all history for both sites, supports recent catch-up, and shows a rejected start', async () => {
    const sent: Array<Record<string, unknown>> = [];
    vi.stubGlobal('chrome', {
      runtime: { sendMessage: async (message: Record<string, unknown>) => {
        sent.push(message);
        return message.type === 'GET_HISTORY_SYNC_STATE' ? { ok: true, state: EMPTY_SYNC_STATE }
          : { ok: false, error: 'Sign in to the selected site.' };
      } },
      storage: { local: {}, onChanged: { addListener() {}, removeListener() {} } },
    });
    const host = document.createElement('div');
    document.body.append(host);
    const root = createRoot(host);
    try {
      await act(async () => root.render(<ImportDialog dialogRef={{ current: null }} settings={DEFAULT_SETTINGS}
        onImported={async () => {}} onOpenThread={() => {}} onClosed={() => {}} />));
      const button = () => Array.from(host.querySelectorAll('button')).find((b) => /Import all online conversations|^Catch up$/.test(b.textContent ?? ''))!;
      expect(button().textContent).toBe('Import all online conversations');
      await act(async () => button().click());
      expect(sent.at(-1)).toMatchObject({ type: 'START_HISTORY_SYNC', scope: 'all', providers: ['chatgpt', 'claude'] });
      expect(host.querySelector('[role="alert"]')?.textContent).toBe('Sign in to the selected site.');
      const period = host.querySelector('select')!;
      await act(async () => { period.value = '7'; period.dispatchEvent(new Event('change', { bubbles: true })); });
      expect(button().textContent).toBe('Catch up');
      await act(async () => button().click());
      expect(sent.at(-1)).toMatchObject({ type: 'START_HISTORY_SYNC', scope: 'recent', days: 7 });
    } finally {
      await act(async () => root.unmount());
      host.remove();
    }
  });

  const site = (patch: Partial<SyncProviderState>): SyncProviderState => ({
    provider: 'chatgpt', label: 'ChatGPT', strategy: 'api', status: 'queued', listed: 0, stored: 0, skipped: 0, failed: 0, message: null, ...patch,
  });

  async function render(node: React.ReactElement) {
    const host = document.createElement('div');
    document.body.append(host);
    const root = createRoot(host);
    await act(async () => root.render(node));
    return {
      host,
      done: async () => {
        await act(async () => root.unmount());
        host.remove();
      },
    };
  }

  it('shows each site\'s step and counts as an accessible progress bar, exact or indeterminate', async () => {
    const state: SyncState = {
      runId: 'sync_ui_1', running: true, days: 30, scope: 'all', startedAt: null, finishedAt: null,
      providers: [
        site({ status: 'fetching', listed: 40, stored: 10, skipped: 2, account: 'Work' }),
        site({ provider: 'claude_code', label: 'Claude Code', strategy: 'sidebar', status: 'listing', listed: 0 }),
      ],
    };
    const view = await render(<ImportProgress state={state} analysisLeft={null} />);
    try {
      const bars = Array.from(view.host.querySelectorAll('[role="progressbar"]'));
      expect(bars).toHaveLength(2);
      expect(bars[0].getAttribute('aria-valuenow')).toBe('12');
      expect(bars[0].getAttribute('aria-valuemax')).toBe('40');
      expect(bars[0].getAttribute('aria-valuetext')).toBe('12 of 40 threads read, 10 imported');
      // Unknown total: no value, so it is announced as indeterminate.
      expect(bars[1].hasAttribute('aria-valuenow')).toBe(false);
      expect(bars[1].getAttribute('data-indeterminate')).toBe('true');
      expect(view.host.textContent).toContain('Step 4 of 4: Importing');
      expect(view.host.textContent).toContain('Filed under Work');
      expect(view.host.textContent).toContain('Step 3 of 4: Finding conversations');
      expect(view.host.querySelector('[role="status"]')?.textContent).toBe('Importing from ChatGPT: Importing.');
    } finally {
      await view.done();
    }
  });

  it('reports the import finished, then analysis as its own later step', async () => {
    const state: SyncState = {
      runId: 'sync_ui_2', running: false, days: 30, startedAt: null, finishedAt: 'x',
      providers: [site({ status: 'done', listed: 5, stored: 5 })],
      analysis: { queued: 5, at: 'x' },
    };
    const view = await render(<ImportProgress state={state} analysisLeft={3} />);
    try {
      expect(view.host.textContent).toContain('Import finished: 5 threads imported.');
      const row = view.host.querySelector('[data-testid="import-analysis"]')!;
      expect(row.textContent).toContain('Analyzing 5 threads');
      expect(row.querySelector('[role="progressbar"]')?.getAttribute('aria-valuetext')).toBe('2 of 5 analyzed');
    } finally {
      await view.done();
    }
  });

  it('offers to continue a run the browser stopped, with that run\'s sites, window and scope', async () => {
    const sent: Array<Record<string, unknown>> = [];
    const interrupted: SyncState = {
      runId: 'sync_ui_3', running: false, interrupted: true, days: 14, scope: 'recent', startedAt: null, finishedAt: 'x',
      providers: [site({ status: 'done', stored: 3 }), site({ provider: 'claude', label: 'Claude', status: 'error', message: 'stopped' })],
    };
    vi.stubGlobal('chrome', {
      runtime: { sendMessage: async (message: Record<string, unknown>) => {
        sent.push(message);
        return message.type === 'GET_HISTORY_SYNC_STATE' ? { ok: true, state: interrupted } : { ok: true };
      } },
      storage: { local: {}, onChanged: { addListener() {}, removeListener() {} } },
    });
    const view = await render(<ImportDialog dialogRef={{ current: null }} settings={DEFAULT_SETTINGS}
      onImported={async () => {}} onOpenThread={() => {}} onClosed={() => {}} />);
    try {
      expect(view.host.textContent).toContain('Coding sessions: Claude Code and Codex');
      const resume = Array.from(view.host.querySelectorAll('button')).find((b) => b.textContent === 'Continue the import')!;
      await act(async () => resume.click());
      expect(sent.at(-1)).toEqual({ type: 'START_HISTORY_SYNC', providers: ['claude'], days: 14, scope: 'recent' });
    } finally {
      await view.done();
    }
  });
});
