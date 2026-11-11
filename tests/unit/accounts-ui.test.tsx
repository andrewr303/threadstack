// Accounts in the interface: the account menu, the Add account dialog, the Settings panel with
// the Mac helper, and the Session Control import.
import 'fake-indexeddb/auto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { AccountMenuButton } from '../../src/entrypoints/manager/accounts/AccountMenu.js';
import { AddAccountDialog } from '../../src/entrypoints/manager/accounts/AddAccountDialog.js';
import { AccountsSettings } from '../../src/entrypoints/manager/accounts/AccountsSettings.js';
import { SessionControlImportSection } from '../../src/entrypoints/manager/accounts/SessionControlImportSection.js';
import { applySessionControlImport } from '../../src/entrypoints/manager/accounts/sessionControlImport.js';
import { configureWorkspaceClient } from '../../src/entrypoints/manager/workspace/client.js';
import { WorkspaceProvider, type WorkspaceContextValue } from '../../src/entrypoints/manager/workspace/context.js';
import type { WorkspaceController } from '../../src/entrypoints/manager/workspace/useWorkspace.js';
import { ThreadkeeperDB } from '../../src/core/db.js';
import { DEFAULT_SETTINGS, buildThreadKey } from '../../src/core/schema.js';
import { parseSessionControlBackup, planSessionControlImport } from '../../src/core/session-control-import.js';
import { realmById } from '../../src/core/workspace/realms.js';
import type { AccountRecord, RealmAccounts } from '../../src/core/workspace/types.js';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

// ---- Fixtures -----------------------------------------------------------------------------------

const PROFILE = '0b9d1c52-7a3e-4c1f-8d55-2f6a9e4b7c10';

function account(over: Partial<AccountRecord> & Pick<AccountRecord, 'id' | 'label'>): AccountRecord {
  return {
    realm: 'anthropic',
    color: 'teal',
    mode: 'embedded',
    primary: false,
    identity: null,
    signedIn: 'unknown',
    hasJar: false,
    order: 0,
    createdAt: '2026-01-01T00:00:00.000Z',
    lastActiveAt: null,
    ...over,
  };
}

const PRIMARY = account({
  id: 'primary~anthropic',
  label: 'Work',
  primary: true,
  signedIn: 'yes',
  identity: { key: 'k1', display: 'work@example.com', observedAt: '2026-01-01T00:00:00.000Z', source: 'network' },
});
const PERSONAL = account({ id: 'acct_aaaa', label: 'Personal', color: 'peach', hasJar: true, order: 1 });
const WINDOWED = account({ id: 'acct_bbbb', label: 'Client', color: 'violet', mode: 'isolated', profileId: PROFILE, order: 2 });

function realms(accounts: AccountRecord[] = [PRIMARY, PERSONAL, WINDOWED], active = 'primary~anthropic'): RealmAccounts[] {
  return [
    { realm: realmById('anthropic')!, accounts, activeAccountId: active },
    { realm: realmById('google')!, accounts: [], activeAccountId: null },
  ];
}

type Spies = ReturnType<typeof makeCtx>['spies'];

function makeCtx(options: { realms?: RealmAccounts[]; enabled?: boolean; switchingRealm?: string | null } = {}) {
  const list = options.realms ?? realms();
  const ok = (account: AccountRecord | null = null) => ({ ok: true as const, account, realms: list, switched: true });
  const spies = {
    switchAccount: vi.fn(async (_id: string): Promise<unknown> => ok()),
    addAccount: vi.fn(async (_input: unknown): Promise<unknown> => ok(account({ id: 'acct_new', label: 'New' }))),
    updateAccount: vi.fn(async (_id: string, _patch: unknown): Promise<unknown> => ok()),
    removeAccount: vi.fn(async (_id: string): Promise<unknown> => ok()),
    openIsolated: vi.fn(async (_id: string, _url: string): Promise<unknown> => ({ ok: true })),
    openUrl: vi.fn((_url: string, _o?: unknown) => ({ ok: true as const, tabId: 'tab_1' })),
    refreshAccounts: vi.fn(async () => undefined),
    setView: vi.fn(),
    announce: vi.fn(),
    requestAddAccount: vi.fn(),
    openSettings: vi.fn(),
    openInChromeTab: vi.fn(),
  };
  const workspace = {
    enabled: options.enabled ?? true,
    realms: list,
    switchingRealm: options.switchingRealm ?? null,
    switchAccount: spies.switchAccount,
    addAccount: spies.addAccount,
    updateAccount: spies.updateAccount,
    removeAccount: spies.removeAccount,
    openIsolated: spies.openIsolated,
    openUrl: spies.openUrl,
    refreshAccounts: spies.refreshAccounts,
  } as unknown as WorkspaceController;
  const value = {
    surface: 'page',
    workspace,
    settings: DEFAULT_SETTINGS,
    patchSettings: vi.fn(),
    view: 'browse',
    setView: spies.setView,
    announce: spies.announce,
    requestAddAccount: spies.requestAddAccount,
    openSettings: spies.openSettings,
    openInChromeTab: spies.openInChromeTab,
  } as unknown as WorkspaceContextValue;
  return { value, spies };
}

// ---- DOM helpers --------------------------------------------------------------------------------

let container: HTMLDivElement;
let root: Root;

// jsdom has no <dialog> methods; showModal and close flip `open` and close fires `close`.
function polyfillDialog(): () => void {
  const proto = HTMLDialogElement.prototype as unknown as Record<string, unknown>;
  const saved = { showModal: proto.showModal, close: proto.close };
  proto.showModal = function (this: HTMLDialogElement) {
    this.setAttribute('open', '');
  };
  proto.close = function (this: HTMLDialogElement) {
    if (!this.hasAttribute('open')) return;
    this.removeAttribute('open');
    this.dispatchEvent(new Event('close'));
  };
  return () => {
    proto.showModal = saved.showModal;
    proto.close = saved.close;
  };
}

let restoreDialog: () => void;

beforeEach(() => {
  restoreDialog = polyfillDialog();
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  restoreDialog();
  configureWorkspaceClient({ send: null });
  vi.unstubAllGlobals();
});

function mount(node: React.ReactNode, ctx?: WorkspaceContextValue) {
  act(() => root.render(ctx ? <WorkspaceProvider value={ctx}>{node}</WorkspaceProvider> : <>{node}</>));
}

const flush = async () => {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
};

const press = async (el: Element) => {
  await act(async () => {
    (el as HTMLElement).click();
  });
  await flush();
};

function byRole(role: string, name?: string | RegExp): HTMLElement | null {
  const nodes = [...document.querySelectorAll<HTMLElement>(`[role="${role}"]`)];
  return nodes.find((n) => !name || matches(n, name)) ?? null;
}

function matches(el: HTMLElement, name: string | RegExp): boolean {
  const text = (el.getAttribute('aria-label') ?? el.textContent ?? '').replace(/\s+/g, ' ').trim();
  return typeof name === 'string' ? text.includes(name) : name.test(text);
}

function button(name: string | RegExp, within: ParentNode = document): HTMLButtonElement {
  const found = [...within.querySelectorAll<HTMLButtonElement>('button')].find((b) => matches(b, name));
  if (!found) throw new Error(`No button named ${String(name)}`);
  return found;
}

function type(input: HTMLInputElement, value: string) {
  act(() => {
    const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
    set.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

const text = () => (document.body.textContent ?? '').replace(/\s+/g, ' ');

// ---- The account menu ---------------------------------------------------------------------------

describe('AccountMenuButton', () => {
  async function openMenu(ctx: WorkspaceContextValue, variant: 'toolbar' | 'rail' = 'toolbar') {
    mount(<AccountMenuButton realmId="anthropic" variant={variant} />, ctx);
    const trigger = container.querySelector('button')!;
    await press(trigger);
    return trigger;
  }

  it('shows the sign-in and the signed-in account on the button, and a labelled menu when opened', async () => {
    const { value } = makeCtx();
    const trigger = await openMenu(value);
    expect(trigger.textContent).toContain('Claude');
    expect(trigger.textContent).toContain('Work');
    expect(trigger.getAttribute('aria-expanded')).toBe('true');
    const menu = byRole('menu')!;
    expect(menu.textContent).toContain('Claude accounts');
    expect(menu.textContent).toContain('One account is signed in at a time. Switching reloads Claude tabs.');
  });

  it('lists the embedded accounts as radios and marks the signed-in one with words', async () => {
    const { value } = makeCtx();
    await openMenu(value);
    const radios = [...document.querySelectorAll('[role="menuitemradio"]')];
    expect(radios.map((r) => r.querySelector('.tk-acct-item-name')?.textContent)).toEqual(['Work', 'Personal']);
    expect(radios[0].getAttribute('aria-checked')).toBe('true');
    expect(radios[0].textContent).toContain('Signed in');
    expect(radios[0].textContent).toContain('work@example.com');
    expect(radios[1].getAttribute('aria-checked')).toBe('false');
    expect(radios[1].textContent).not.toContain('Signed in');
  });

  it('switches, announces, closes the menu and returns focus to the button', async () => {
    const { value, spies } = makeCtx();
    const trigger = await openMenu(value);
    await press(byRole('menuitemradio', 'Personal')!);
    expect(spies.switchAccount).toHaveBeenCalledWith('acct_aaaa');
    expect(spies.announce).toHaveBeenCalledWith('Claude is now signed in as Personal.');
    expect(byRole('menu')).toBeNull();
    expect(document.activeElement).toBe(trigger);
  });

  it('keeps the menu open and shows the error when a switch fails', async () => {
    const { value, spies } = makeCtx();
    spies.switchAccount.mockResolvedValueOnce({ ok: false, error: 'Allow Threadkeeper to access Claude first.', code: 'needs_host_access' });
    await openMenu(value);
    await press(byRole('menuitemradio', 'Personal')!);
    expect(byRole('menu')).not.toBeNull();
    expect(byRole('alert')!.textContent).toContain('Allow Threadkeeper to access Claude first.');
    expect(spies.announce).not.toHaveBeenCalled();
  });

  it('shows a busy state while this sign-in is being switched and ignores further choices', async () => {
    const { value, spies } = makeCtx({ switchingRealm: 'anthropic' });
    const trigger = await openMenu(value);
    expect(trigger.getAttribute('aria-busy')).toBe('true');
    await press(byRole('menuitemradio', 'Personal')!);
    expect(spies.switchAccount).not.toHaveBeenCalled();
  });

  it('lists a separate-window account under its own heading and opens its window', async () => {
    const { value, spies } = makeCtx();
    await openMenu(value);
    expect(text()).toContain('In their own window');
    await press(byRole('menuitem', 'Client')!);
    expect(spies.openIsolated).toHaveBeenCalledWith('acct_bbbb', realmById('anthropic')!.homeUrl);
    expect(spies.announce).toHaveBeenCalledWith('Opening Client in its own Chrome window.');
  });

  it('opens Add account for this sign-in and Manage accounts in Settings', async () => {
    const { value, spies } = makeCtx();
    await openMenu(value);
    await press(byRole('menuitem', 'Add account')!);
    expect(spies.requestAddAccount).toHaveBeenCalledWith('anthropic');
    await press(container.querySelector('button')!);
    await press(byRole('menuitem', 'Manage accounts')!);
    expect(spies.openSettings).toHaveBeenCalledWith('accounts');
  });

  it('for a sign-in that is not switched, says why and offers no accounts', async () => {
    const { value } = makeCtx();
    mount(<AccountMenuButton realmId="google" variant="rail" />, value);
    await press(container.querySelector('button')!);
    const menu = byRole('menu')!;
    expect(menu.textContent).toContain(realmById('google')!.fixedReason!);
    expect(document.querySelector('[role="menuitemradio"]')).toBeNull();
    expect(menu.textContent).not.toContain('Add account');
  });

  it('closes on Escape and gives focus back to the button', async () => {
    const { value } = makeCtx();
    const trigger = await openMenu(value);
    await act(async () => {
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
    });
    expect(byRole('menu')).toBeNull();
    expect(document.activeElement).toBe(trigger);
  });
});

// ---- The Add account dialog ---------------------------------------------------------------------

describe('AddAccountDialog', () => {
  function mountDialog(ctx: WorkspaceContextValue, realmId: string | null = 'anthropic') {
    const ref = { current: null as HTMLDialogElement | null };
    const onClosed = vi.fn();
    mount(<AddAccountDialog dialogRef={ref} realmId={realmId} onClosed={onClosed} />, ctx);
    return { ref, onClosed };
  }
  // The dialog resets its form when it sees itself open (a microtask later), so wait for that.
  const open = async (ref: { current: HTMLDialogElement | null }) => {
    await act(async () => {
      ref.current!.showModal();
      await Promise.resolve();
    });
  };
  const nameInput = () => document.querySelector<HTMLInputElement>('#tk-add-account-dialog input[type="text"]')!;
  const submit = () => button('Add account', document.querySelector('#tk-add-account-dialog footer')!);

  it('requires a name before anything is added', async () => {
    const { value, spies } = makeCtx();
    const { ref } = mountDialog(value);
    await open(ref);
    await press(submit());
    expect(spies.addAccount).not.toHaveBeenCalled();
    expect(document.querySelector('#tk-add-account-dialog [role="alert"]')!.textContent).toBe(
      'Add a name so you can tell this account apart.'
    );
    expect(nameInput().getAttribute('aria-invalid')).toBe('true');
    expect(nameInput().maxLength).toBe(40);
  });

  it('offers the six named colours and the two places an account can run, as radio groups', async () => {
    const { value } = makeCtx();
    const { ref } = mountDialog(value);
    await open(ref);
    const groups = [...document.querySelectorAll('#tk-add-account-dialog [role="radiogroup"]')];
    expect(groups).toHaveLength(2);
    expect(groups[0].textContent).toBe('TealPeachVioletSageBlueGold');
    expect(groups[1].textContent).toContain('In the workspace');
    expect(groups[1].textContent).toContain('In its own Chrome window (Mac helper)');
    expect(groups[1].querySelectorAll('input[type="radio"]')).toHaveLength(2);
    // Teal, peach and violet are taken by the existing accounts, so the form starts on the next free colour.
    expect((groups[0].querySelector('input:checked') as HTMLInputElement).value).toBe('sage');
  });

  it('says what will be signed out before the button is pressed, and what is saved', async () => {
    const { value } = makeCtx();
    const { ref } = mountDialog(value);
    await open(ref);
    expect(text()).toContain(
      'Claude will be signed out here and in your other Chrome tabs so you can sign in as this account. The sign-in for Work is saved and comes back when you switch to it.'
    );
    const isolated = document.querySelector<HTMLInputElement>('#tk-add-account-dialog input[value="isolated"]')!;
    act(() => isolated.click());
    expect(text()).not.toContain('will be signed out here');
    expect(text()).toContain('Nothing is signed out here.');
  });

  it('adds an embedded account, opens its sign-in page for it in Browse and announces what to do', async () => {
    const permissions = { request: vi.fn(async () => true) };
    vi.stubGlobal('chrome', { permissions });
    const { value, spies } = makeCtx();
    const { ref, onClosed } = mountDialog(value, 'openai');
    await open(ref);
    type(nameInput(), '  Team  ');
    await press(submit());

    // The sign-in's extra host is asked for in the click, before the account is added.
    expect(permissions.request).toHaveBeenCalledWith({ origins: ['https://auth.openai.com/*'] });
    expect(spies.addAccount).toHaveBeenCalledWith({ realm: 'openai', mode: 'embedded', label: 'Team', color: 'teal' });
    expect(spies.openUrl).toHaveBeenCalledWith('https://chatgpt.com/auth/login', { accountId: 'acct_new', title: 'Sign in' });
    expect(spies.setView).toHaveBeenCalledWith('browse');
    expect(spies.announce).toHaveBeenCalledWith(
      'Sign in to ChatGPT as Team. If the sign-in needs a step that cannot run here, use Open in Chrome tab, then reload.'
    );
    expect(ref.current!.hasAttribute('open')).toBe(false);
    expect(onClosed).toHaveBeenCalled();
  });

  it('adds an account in its own window without opening a page here', async () => {
    const { value, spies } = makeCtx();
    const { ref } = mountDialog(value);
    await open(ref);
    type(nameInput(), 'Client');
    act(() => document.querySelector<HTMLInputElement>('#tk-add-account-dialog input[value="isolated"]')!.click());
    await press(submit());
    expect(spies.addAccount).toHaveBeenCalledWith(expect.objectContaining({ realm: 'anthropic', mode: 'isolated', label: 'Client' }));
    expect(spies.openUrl).not.toHaveBeenCalled();
    expect(spies.setView).not.toHaveBeenCalled();
    expect(spies.announce.mock.calls[0][0]).toContain('own Chrome window');
    expect(ref.current!.hasAttribute('open')).toBe(false);
  });

  it('keeps a failure in the dialog with help, and retries after host access is allowed', async () => {
    const permissions = { request: vi.fn(async () => true) };
    vi.stubGlobal('chrome', { permissions });
    const { value, spies } = makeCtx();
    spies.addAccount.mockResolvedValueOnce({ ok: false, error: 'Allow Threadkeeper to access Claude first.', code: 'needs_host_access' });
    const { ref } = mountDialog(value);
    await open(ref);
    type(nameInput(), 'Team');
    await press(submit());

    const alert = document.querySelector('#tk-add-account-dialog [role="alert"]')!;
    expect(alert.textContent).toContain('Allow Threadkeeper to access Claude first.');
    expect(ref.current!.hasAttribute('open')).toBe(true);
    expect(spies.openUrl).not.toHaveBeenCalled();

    await press(button('Allow access to Claude and retry', alert));
    expect(permissions.request).toHaveBeenCalledWith({ origins: ['https://*.claude.ai/*'] });
    expect(spies.addAccount).toHaveBeenCalledTimes(2);
    expect(spies.openUrl).toHaveBeenCalled();
    expect(ref.current!.hasAttribute('open')).toBe(false);
  });

  it('points to Settings, Accounts, Mac helper when the helper is unavailable', async () => {
    const { value, spies } = makeCtx();
    spies.addAccount.mockResolvedValueOnce({ ok: false, error: 'The Mac helper did not answer.', code: 'helper_unavailable' });
    const { ref } = mountDialog(value);
    await open(ref);
    type(nameInput(), 'Client');
    act(() => document.querySelector<HTMLInputElement>('#tk-add-account-dialog input[value="isolated"]')!.click());
    await press(submit());
    const alert = document.querySelector('#tk-add-account-dialog [role="alert"]')!;
    expect(alert.textContent).toContain('Settings, Accounts, Mac helper');
    await press(button('Open Mac helper settings', alert));
    expect(spies.openSettings).toHaveBeenCalledWith('accounts');
  });

  it('starts empty each time it opens and closes without changes on Cancel', async () => {
    const { value, spies } = makeCtx();
    const { ref, onClosed } = mountDialog(value);
    await open(ref);
    type(nameInput(), 'Draft');
    await press(button('Cancel', document.querySelector('#tk-add-account-dialog')!));
    expect(spies.addAccount).not.toHaveBeenCalled();
    expect(onClosed).toHaveBeenCalledTimes(1);
    await open(ref);
    await flush();
    expect(nameInput().value).toBe('');
  });
});

// ---- Settings, Accounts -------------------------------------------------------------------------

describe('AccountsSettings', () => {
  it('explains how switching works in the plain facts', () => {
    const { value } = makeCtx();
    mount(<AccountsSettings />, value);
    const t = text();
    expect(t).toContain('one account of each sign-in is signed in at a time');
    expect(t).toContain('encrypted, never exported or sent anywhere');
    expect(t).toContain('Only cookies are swapped');
    expect(t).toContain('never sees or stores your passwords');
  });

  it('shows each account with who it is, whether it is signed in, and where it runs', () => {
    const { value } = makeCtx();
    mount(<AccountsSettings />, value);
    const rows = [...container.querySelectorAll('.tk-acct-row')];
    expect(rows).toHaveLength(3);
    expect(rows[0].textContent).toContain('work@example.com');
    expect(rows[0].textContent).toContain('Signed in now');
    expect(rows[0].textContent).toContain('In the workspace');
    expect(rows[1].textContent).toContain('Identity not seen yet');
    expect(rows[1].textContent).toContain('Not signed in now');
    expect(rows[2].textContent).toContain('In its own Chrome window');
  });

  it('renames an account inline and saves it with updateAccount', async () => {
    const { value, spies } = makeCtx();
    mount(<AccountsSettings />, value);
    const input = container.querySelector<HTMLInputElement>('#tk-acct-name-acct_aaaa')!;
    expect([...container.querySelectorAll('button')].some((b) => b.textContent === 'Save name')).toBe(false);
    type(input, 'Home');
    await press(button('Save name'));
    expect(spies.updateAccount).toHaveBeenCalledWith('acct_aaaa', { label: 'Home' });
    expect(spies.announce).toHaveBeenCalledWith('Renamed the account to Home.');
  });

  it('changes the colour with updateAccount', async () => {
    const { value, spies } = makeCtx();
    mount(<AccountsSettings />, value);
    const select = container.querySelectorAll<HTMLSelectElement>('.tk-acct-colorpick select')[1];
    await act(async () => {
      select.value = 'gold';
      select.dispatchEvent(new Event('change', { bubbles: true }));
    });
    expect(spies.updateAccount).toHaveBeenCalledWith('acct_aaaa', { color: 'gold' });
  });

  it('never offers Remove for the primary account, and asks first for the others', async () => {
    const { value, spies } = makeCtx();
    mount(<AccountsSettings />, value);
    const names = [...container.querySelectorAll('button')].map((b) => b.getAttribute('aria-label') ?? '');
    expect(names).not.toContain('Remove Work');
    expect(names).toContain('Remove Personal');

    await press(button('Remove Personal'));
    expect(spies.removeAccount).not.toHaveBeenCalled();
    expect(text()).toContain('Its saved sign-in is deleted from this device and its threads stay in the library.');
    // Changing one's mind leaves everything as it was.
    await press(button('Keep account'));
    expect(spies.removeAccount).not.toHaveBeenCalled();
    expect(document.activeElement).toBe(button('Remove Personal'));

    await press(button('Remove Personal'));
    await press(button('Remove account'));
    expect(spies.removeAccount).toHaveBeenCalledWith('acct_aaaa');
    expect(spies.announce).toHaveBeenCalledWith('Removed Personal. Its threads stay in the library.');
  });

  it('shows the reason when a change fails', async () => {
    const { value, spies } = makeCtx();
    spies.removeAccount.mockResolvedValueOnce({ ok: false, error: 'A primary account cannot be removed.' });
    mount(<AccountsSettings />, value);
    await press(button('Remove Client'));
    await press(button('Remove account'));
    expect(byRole('alert')!.textContent).toContain('A primary account cannot be removed.');
  });

  it('opens Add account from the panel', async () => {
    const { value, spies } = makeCtx();
    mount(<AccountsSettings />, value);
    await press(button(/^Add account$/));
    expect(spies.requestAddAccount).toHaveBeenCalledWith();
  });

  it('where the workspace is not enabled, says accounts are managed from the full page', async () => {
    const create = vi.fn();
    vi.stubGlobal('chrome', { tabs: { create }, runtime: { getURL: (p: string) => `chrome-extension://x/${p}` } });
    const { value } = makeCtx({ enabled: false });
    mount(<AccountsSettings />, value);
    expect(text()).toContain('Accounts are managed from the full page');
    expect(container.querySelector('.tk-acct-row')).toBeNull();
    await press(button('Open the full page'));
    expect(create).toHaveBeenCalledWith({ url: 'chrome-extension://x/manager.html?surface=page' });
  });
});

describe('Mac helper panel', () => {
  it('asks for the optional permission in the click, pings the helper and shows the version', async () => {
    const request = vi.fn(async () => true);
    vi.stubGlobal('chrome', { permissions: { request }, runtime: { id: 'abcdefghijklmnopabcdefghijklmnop' } });
    const send = vi.fn(async () => ({ ok: true, version: '1.2.0', platform: 'darwin' }));
    configureWorkspaceClient({ send });
    const { value } = makeCtx();
    mount(<AccountsSettings />, value);
    await press(button('Check connection'));
    expect(request).toHaveBeenCalledWith({ permissions: ['nativeMessaging'] });
    expect(send).toHaveBeenCalledWith({ type: 'HELPER_PING' });
    expect(container.querySelector('.tk-acct-helper-result')!.textContent).toBe('Connected (version 1.2.0)');
  });

  it('shows why it is not connected, and does not ping when the permission is refused', async () => {
    const request = vi.fn(async () => false);
    vi.stubGlobal('chrome', { permissions: { request }, runtime: { id: 'abcdefghijklmnopabcdefghijklmnop' } });
    const send = vi.fn();
    configureWorkspaceClient({ send });
    const { value } = makeCtx();
    mount(<AccountsSettings />, value);
    await press(button('Check connection'));
    expect(send).not.toHaveBeenCalled();
    expect(container.querySelector('.tk-acct-helper-result')!.textContent).toContain('did not allow');

    request.mockResolvedValue(true);
    send.mockResolvedValue({ ok: false, error: 'Install the Mac helper first.', code: 'helper_unavailable' });
    await press(button('Check connection'));
    expect(container.querySelector('.tk-acct-helper-result')!.textContent).toBe('Not connected. Install the Mac helper first.');
  });

  it('shows the extension ID, copies it, and lists the install steps in order', async () => {
    const writeText = vi.fn(async () => undefined);
    vi.stubGlobal('chrome', { runtime: { id: 'abcdefghijklmnopabcdefghijklmnop' } });
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
    const { value, spies } = makeCtx();
    mount(<AccountsSettings />, value);
    expect(container.querySelector('.tk-acct-extid-code')!.textContent).toBe('abcdefghijklmnopabcdefghijklmnop');
    await press(button('Copy extension ID'));
    expect(writeText).toHaveBeenCalledWith('abcdefghijklmnopabcdefghijklmnop');
    expect(spies.announce).toHaveBeenCalledWith('Extension ID copied.');
    const steps = [...container.querySelectorAll('ol.tk-acct-steps > li')].map((li) => li.textContent ?? '');
    expect(steps).toHaveLength(4);
    expect(steps[1]).toContain('Install Mac Helper.command');
  });
});

// ---- Session Control import ---------------------------------------------------------------------

function backup() {
  return {
    version: 1,
    accounts: [
      { id: 'a-main', name: 'Main', email: 'me@example.com', color: 'peach', mode: 'current' },
      { id: 'a-client', name: 'Client', email: 'client@example.com', color: 'violet', mode: 'isolated', profileId: PROFILE },
    ],
    workspaces: [
      { id: 'personal', name: 'Personal', icon: 'user' },
      { id: 'w-pay', name: 'Payments', icon: 'code' },
    ],
    sessions: [
      { id: 's1', accountId: 'a-main', workspaceId: 'personal', title: 'Main session', url: 'https://claude.ai/code/session_main1', notes: '', repository: '', branch: '', status: 'saved', pinned: false, archived: false, updatedAt: 1760000000000, createdAt: 1750000000000 },
      { id: 's2', accountId: 'a-client', workspaceId: 'w-pay', title: 'Client session', url: 'https://claude.ai/code/session_client1', notes: 'n', repository: 'acme/shop', branch: 'fix', status: 'attention', pinned: true, archived: false, updatedAt: 1760000000000, createdAt: 1750000000000 },
      { id: 's3', accountId: 'a-client', workspaceId: 'w-pay', title: 'Home page', url: 'https://claude.ai/code', notes: '', repository: '', branch: '', status: 'saved', pinned: false, archived: false, updatedAt: 1, createdAt: 1 },
    ],
    activity: [],
    settings: { compact: false },
  };
}

let dbCounter = 0;
const freshDb = () => new ThreadkeeperDB(`AccountsUiImport_${Date.now()}_${++dbCounter}`);
const bound = DEFAULT_SETTINGS.boundAccounts.claude_code;
const plan = () =>
  planSessionControlImport(parseSessionControlBackup(JSON.stringify(backup())), {
    boundClaudeCodeAccountId: bound.accountId,
    workspaceId: bound.workspaceId,
  });
const keyFor = (accountId: string, session: string) =>
  buildThreadKey({ provider: 'claude_code', accountId, workspaceId: bound.workspaceId, sourceConversationId: session, branchId: 'main' });

describe('Session Control import', () => {
  it('reuses the account that already has the same profile and files its sessions under that id', async () => {
    const db = freshDb();
    const addAccount = vi.fn();
    const existing = realms([PRIMARY, WINDOWED]);
    const outcome = await applySessionControlImport(plan(), { db, realms: existing, addAccount });

    expect(addAccount).not.toHaveBeenCalled();
    const keys = (await db.conversations.toCollection().primaryKeys()) as string[];
    expect(keys.sort()).toEqual([keyFor(bound.accountId, 'session_main1'), keyFor('acct_bbbb', 'session_client1')].sort());
    const client = await db.conversations.get(keyFor('acct_bbbb', 'session_client1'));
    expect(client?.accountId).toBe('acct_bbbb');
    expect(outcome.sessionsImported).toBe(2);
    expect(outcome.accountsCreated).toBe(0);
    // The project is created the way the app creates one.
    expect(await db.collections.get('Payments')).toMatchObject({ origin: 'user', isStarterArea: false, cloudExcluded: false });
    expect(outcome.skipped).toHaveLength(1);
    expect(outcome.message).toBe('Imported 2 sessions from Session Control. 1 skipped.');
  });

  it('creates a missing isolated account with its profile and rebuilds the thread keys for the id it gets', async () => {
    const db = freshDb();
    const created = account({ id: 'acct_real1', label: 'Client', color: 'violet', mode: 'isolated', profileId: PROFILE });
    const addAccount = vi.fn(async () => ({ ok: true as const, account: created, realms: realms([PRIMARY, created]), switched: false }));
    const p = plan();
    const plannedId = p.accounts.find((a) => !a.primary)!.accountId;
    expect(plannedId).not.toBe('acct_real1');

    const outcome = await applySessionControlImport(p, { db, realms: realms([PRIMARY]), addAccount });
    expect(addAccount).toHaveBeenCalledWith({ realm: 'anthropic', mode: 'isolated', label: 'Client', color: 'violet', profileId: PROFILE });
    expect(await db.conversations.get(keyFor('acct_real1', 'session_client1'))).toBeTruthy();
    expect(await db.conversations.get(keyFor(plannedId, 'session_client1'))).toBeUndefined();
    expect(outcome.accountsCreated).toBe(1);
    expect(outcome.message).toBe('Imported 2 sessions and 1 account from Session Control. 1 skipped.');
  });

  it('adds nothing the second time', async () => {
    const db = freshDb();
    const created = account({ id: 'acct_real1', label: 'Client', color: 'violet', mode: 'isolated', profileId: PROFILE });
    const after = realms([PRIMARY, created]);
    const addAccount = vi.fn(async () => ({ ok: true as const, account: created, realms: after, switched: false }));
    await applySessionControlImport(plan(), { db, realms: realms([PRIMARY]), addAccount });
    const before = await db.conversations.count();

    const second = await applySessionControlImport(plan(), { db, realms: after, addAccount });
    expect(addAccount).toHaveBeenCalledTimes(1);
    expect(await db.conversations.count()).toBe(before);
    expect(second.sessionsImported).toBe(0);
    expect(second.accountsCreated).toBe(0);
    expect(second.message).toContain('0 sessions');
    expect(second.message).toContain('2 of them already in the library');
  });

  it('skips the sessions of an account that could not be added and says why', async () => {
    const db = freshDb();
    const addAccount = vi.fn(async () => ({ ok: false as const, error: 'The Mac helper did not answer.', code: 'helper_unavailable' as const }));
    const outcome = await applySessionControlImport(plan(), { db, realms: realms([PRIMARY]), addAccount });
    expect(outcome.sessionsImported).toBe(1);
    expect(outcome.message).toContain('Could not add Client: The Mac helper did not answer.');
    expect(await db.conversations.count()).toBe(1);
  });

  async function chooseFile(contents: string) {
    const input = container.querySelector<HTMLInputElement>('input[type="file"]')!;
    const file = new File([contents], 'session-control-backup.json', { type: 'application/json' });
    Object.defineProperty(input, 'files', { value: [file], configurable: true });
    await act(async () => {
      input.dispatchEvent(new Event('change', { bubbles: true }));
    });
    await flush();
    await flush();
  }

  it('previews the file, then imports on request and reports what happened', async () => {
    const onImported = vi.fn();
    const { value } = makeCtx({ realms: realms([PRIMARY, WINDOWED]) });
    mount(<SessionControlImportSection settings={DEFAULT_SETTINGS} onImported={onImported} />, value);
    await chooseFile(JSON.stringify(backup()));

    const preview = container.querySelector('.tk-acct-preview')!;
    expect(preview.textContent).toContain('Sessions to import2');
    expect(preview.textContent).toContain('Client');
    expect(preview.textContent).toContain('Already added');
    expect(preview.textContent).toContain('Payments');
    expect(preview.textContent).toContain('The address is the Claude Code home page, not a session.');

    await press(button('Import sessions'));
    await act(async () => {
      await new Promise((r) => setTimeout(r, 50));
    });
    expect(onImported).toHaveBeenCalledTimes(1);
    expect(onImported.mock.calls[0][0]).toBe('Imported 2 sessions from Session Control. 1 skipped.');
  });

  it('shows the parser message when the file is not a backup', async () => {
    const { value } = makeCtx();
    mount(<SessionControlImportSection settings={DEFAULT_SETTINGS} onImported={vi.fn()} />, value);
    await chooseFile('{"hello": 1}');
    expect(byRole('alert')!.textContent).toBe('This is not a supported Session Control backup.');
    expect(container.querySelector('.tk-acct-preview')).toBeNull();
  });

  it('where the workspace is not enabled, says the import runs from the full page', () => {
    const { value } = makeCtx({ enabled: false });
    mount(<SessionControlImportSection settings={DEFAULT_SETTINGS} onImported={vi.fn()} />, value);
    expect(text()).toContain('The Session Control import runs from the full page');
    expect(container.querySelector('input[type="file"]')).toBeNull();
  });
});

// ---- Settings dialog: the section and the two General controls ----------------------------------

describe('SettingsDialog additions', () => {
  async function mountSettings(onPatch = vi.fn(async () => undefined), settings = DEFAULT_SETTINGS) {
    const { SettingsDialog } = await import('../../src/entrypoints/manager/SettingsDialog.js');
    const ref = { current: null as HTMLDialogElement | null };
    const { value } = makeCtx();
    mount(
      <SettingsDialog
        dialogRef={ref}
        settings={settings}
        threadCount={0}
        collections={[]}
        projectCounts={{}}
        onCollectionsChanged={() => undefined}
        onPatch={onPatch}
        onRebuildVectors={() => undefined}
        onClosed={() => undefined}
      />,
      value
    );
    await flush();
    return onPatch;
  }

  it('lists Accounts after Capture and shows the accounts panel when chosen', async () => {
    await mountSettings();
    const names = [...document.querySelectorAll('.tk-settings-nav .tk-nav-item > span:first-child')].map((n) => n.textContent);
    expect(names.indexOf('Accounts')).toBe(names.indexOf('Capture') + 1);
    await press(button('Accounts', document.querySelector('.tk-settings-nav')!));
    expect(document.querySelector('[data-testid="settings-panel-accounts"]')!.textContent).toContain('How switching works');
  });

  it('turns surfaces solid with the toggle and keeps pages loaded within 2 to 12', async () => {
    const onPatch = await mountSettings();
    const toggle = [...document.querySelectorAll<HTMLInputElement>('label.tk-toggle input')].find((i) =>
      i.parentElement!.textContent!.includes('Solid surfaces')
    )!;
    expect(toggle.parentElement!.textContent).toContain('Replace translucent panels with opaque ones.');
    await press(toggle);
    expect(onPatch).toHaveBeenCalledWith({ surfaces: 'solid' });

    const field = [...document.querySelectorAll<HTMLInputElement>('input[type="number"]')].find(
      (i) => i.getAttribute('aria-describedby') === 'tk-live-frames-hint'
    )!;
    expect(field.value).toBe(String(DEFAULT_SETTINGS.maxLiveFrames));
    expect(document.getElementById('tk-live-frames-hint')!.textContent).toBe(
      'More pages stay ready in the background; each uses memory.'
    );
    type(field, '40');
    await act(async () => {
      field.dispatchEvent(new FocusEvent('focusout', { bubbles: true }));
    });
    expect(onPatch).toHaveBeenCalledWith({ maxLiveFrames: 12 });
  });
});
