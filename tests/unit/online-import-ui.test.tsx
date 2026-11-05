import 'fake-indexeddb/auto';
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ImportDialog } from '../../src/entrypoints/manager/ImportDialog.js';
import { DEFAULT_SETTINGS } from '../../src/core/schema.js';
import { EMPTY_SYNC_STATE } from '../../src/core/history-sync.js';

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
});
