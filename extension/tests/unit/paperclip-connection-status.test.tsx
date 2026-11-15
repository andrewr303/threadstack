import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PaperclipStatus, type PaperclipConnection } from '../../src/entrypoints/manager/PaperclipConnection.js';
import type { PaperclipLifecycleSnapshot } from '../../src/core/paperclip/lifecycle.js';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let root: Root; let host: HTMLDivElement;
beforeEach(() => { host = document.createElement('div'); document.body.append(host); root = createRoot(host); });
afterEach(() => { act(() => root.unmount()); host.remove(); });

const origin = 'http://localhost:3100';
const START_NOTE = 'Run "pnpm paperclipai service start" in the Paperclip folder, or install the Mac helper to start it automatically.';
const LOGS_NOTE = 'See "pnpm paperclipai service logs" for details.';
const REINSTALL = 'Run "Install Mac Helper.command" again and choose the Paperclip folder.';

function mount(snapshot: PaperclipLifecycleSnapshot, extra: Partial<PaperclipConnection> = {}) {
  const connection = { snapshot, retry: vi.fn(), setup: vi.fn(), allowAccess: vi.fn(), ...extra };
  act(() => root.render(<PaperclipStatus connection={connection} onConfigure={vi.fn()} />));
  return connection;
}
const buttons = () => Array.from(host.querySelectorAll('button')).map(b => b.textContent);
const notes = () => Array.from(host.querySelectorAll('.tk-settings-note')).map(n => n.textContent);

describe('PaperclipStatus copy and actions per state', () => {
  it.each([
    ['running', {}, 'Paperclip is running', [], []],
    ['starting', {}, 'Starting Paperclip…', [], []],
    ['stopped', { helperConnected: true }, 'Paperclip is stopped', ['Start'], [START_NOTE]],
    ['stopped', { helperConnected: false, reason: 'helper_unavailable' }, 'Paperclip is stopped', [], [START_NOTE]],
    ['not_installed', {}, 'Paperclip is not set up on this Mac', ['Set up Paperclip'], []],
    ['not_installed', { reason: 'paperclip_not_registered' }, REINSTALL, [], []],
    ['needs_sign_in', {}, 'Paperclip needs you to sign in', ['Sign in'], []],
    ['setup_pending', {}, 'Finish setting up Paperclip', ['Open Paperclip'], []],
    ['unreachable', {}, `Can't reach Paperclip at ${origin}`, ['Retry', 'Allow access'], []],
    ['start_failed', { reason: 'paperclip_start_failed' }, 'Paperclip did not start: the Mac helper could not start it.', ['Retry'], [LOGS_NOTE]],
    ['start_failed', { reason: 'startup timed out' }, 'Paperclip did not start: startup timed out', ['Retry'], [LOGS_NOTE]],
    ['start_failed', { reason: 'paperclip_not_registered' }, REINSTALL, [], []],
  ] as const)('%s %j', (state, extra, status, expectedButtons, expectedNotes) => {
    mount({ state, origin, ...extra } as PaperclipLifecycleSnapshot);
    expect(host.querySelector('[role="status"]')?.textContent).toBe(status);
    expect(buttons()).toEqual([...expectedButtons]);
    expect(notes()).toEqual([...expectedNotes]);
    expect(host.textContent).not.toMatch(/paperclip_[a-z_]+|helper_unavailable|unsupported_platform/);
  });

  it('wires Start, Retry and Set up to the connection', () => {
    const stopped = mount({ state: 'stopped', origin, helperConnected: true });
    act(() => host.querySelector('button')!.click());
    expect(stopped.retry).toHaveBeenCalledTimes(1);
    const setup = mount({ state: 'not_installed', origin });
    act(() => host.querySelector('button')!.click());
    expect(setup.setup).toHaveBeenCalledTimes(1);
  });
});
