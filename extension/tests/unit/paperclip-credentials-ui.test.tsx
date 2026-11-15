import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { normalizeSettings, type SettingsRecord } from '../../src/core/schema.js';
import { PaperclipCredentials } from '../../src/entrypoints/manager/PaperclipCredentials.js';
import { configureWorkspaceClient } from '../../src/entrypoints/manager/workspace/client.js';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
let root: Root | null = null;
afterEach(() => { if (root) act(() => root!.unmount()); root = null; configureWorkspaceClient({ send: null }); document.body.innerHTML = ''; });
async function mount(initial: SettingsRecord) {
  const host = document.createElement('div'); document.body.append(host); root = createRoot(host);
  let current = initial;
  const render = () => root!.render(<PaperclipCredentials settings={current} companies={[{ id: 'company-a', name: 'Acme' }]} onPatch={async (patch) => { current = { ...current, ...patch }; render(); }} />);
  await act(async () => { render(); });
  return host;
}
describe('model key settings', () => {
  it('starts off and makes no credential request until a company is chosen', async () => {
    const send = vi.fn(); configureWorkspaceClient({ send });
    const host = await mount(normalizeSettings(null));
    expect(host.textContent).toContain('Model keys');
    expect((host.querySelector('input[type=checkbox]') as HTMLInputElement).checked).toBe(false);
    expect(send).not.toHaveBeenCalled();
  });
  it('shows missing secrets and sends metadata-only unlink requests', async () => {
    const send = vi.fn(async () => ({ ok: true, data: { companyId: 'company-a', linkedKeys: [], missingKeys: ['voyageApiKey'], allowSecretTransfer: false, secrets: [] } }));
    configureWorkspaceClient({ send });
    const settings = { ...normalizeSettings(null), paperclipCredentials: { companyId: 'company-a', linkedKeys: ['voyageApiKey'], allowSecretTransfer: false } };
    const host = await mount(settings);
    expect(host.textContent).toContain('Secret missing');
    expect(JSON.stringify(send.mock.calls)).not.toContain('value');
  });
  it('deselecting the source asks the worker to clear the previous company, not only local state (REQ-14 F-6)', async () => {
    const send = vi.fn(async () => ({ ok: true, data: { companyId: '', linkedKeys: [], missingKeys: [], allowSecretTransfer: false, secrets: [] } }));
    configureWorkspaceClient({ send });
    const host = await mount({ ...normalizeSettings(null), paperclipCredentials: { companyId: 'company-a', linkedKeys: [], allowSecretTransfer: true } });
    const select = host.querySelector('select') as HTMLSelectElement;
    await act(async () => { select.value = ''; select.dispatchEvent(new Event('change', { bubbles: true })); });
    expect(JSON.stringify(send.mock.calls)).toContain('credentials.clear');
    expect((host.querySelector('input[type=checkbox]') as HTMLInputElement).checked).toBe(false);
  });
});
