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
import { realmHostOrigins } from '../../src/entrypoints/manager/accounts/common.js';
import { configureWorkspaceClient } from '../../src/entrypoints/manager/workspace/client.js';
import { WorkspaceProvider, type WorkspaceContextValue } from '../../src/entrypoints/manager/workspace/context.js';
import type { WorkspaceController } from '../../src/entrypoints/manager/workspace/useWorkspace.js';
import { ThreadkeeperDB } from '../../src/core/db.js';
import { DEFAULT_SETTINGS, buildThreadKey } from '../../src/core/schema.js';
import { parseSessionControlBackup, planSessionControlImport } from '../../src/core/session-control-import.js';
import { realmById } from '../../src/core/workspace/realms.js';
import type { AccountRecord, RealmAccounts, SessionTab } from '../../src/core/workspace/types.js';

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
// Brought over from Session Control, where it had its own Chrome window: an account like any other
// now, as the worker presents it, that still needs a sign-in.
const WINDOWED = account({ id: 'acct_bbbb', label: 'Client', color: 'violet', profileId: PROFILE, signedIn: 'no', order: 2 });

function realms(accounts: AccountRecord[] = [PRIMARY, PERSONAL, WINDOWED], active = 'primary~anthropic'): RealmAccounts[] {
  return [
    { realm: realmById('anthropic')!, accounts, activeAccountId: active },
    { realm: realmById('google')!, accounts: [], activeAccountId: null },
  ];
}

type Spies = ReturnType<typeof makeCtx>['spies'];

function makeCtx(options: { realms?: RealmAccounts[]; enabled?: boolean; busyRealm?: string | null; tabs?: SessionTab[]; activeTabId?: string | null } = {}) {
  const list = options.realms ?? realms();
  const ok = (account: AccountRecord | null = null) => ({ ok: true as const, account, realms: list, switched: true });
  const spies = {
    goToAccount: vi.fn((_id: string): unknown => ({ ok: true as const, tabId: 'tab_1' })),
    useAsBrowserAccount: vi.fn(async (_id: string): Promise<unknown> => ok()),
    beginBrowserSignIn: vi.fn(async (_id: string): Promise<unknown> => ok()),
    addAccount: vi.fn(async (_input: unknown): Promise<unknown> => ok(account({ id: 'acct_new', label: 'New' }))),
    updateAccount: vi.fn(async (_id: string, _patch: unknown): Promise<unknown> => ok()),
    removeAccount: vi.fn(async (_id: string): Promise<unknown> => ok()),
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
    busyRealm: options.busyRealm ?? null,
    state: { tabs: options.tabs ?? [], activeTabId: options.activeTabId ?? null },
    goToAccount: spies.goToAccount,
    useAsBrowserAccount: spies.useAsBrowserAccount,
    beginBrowserSignIn: spies.beginBrowserSignIn,
    addAccount: spies.addAccount,
    updateAccount: spies.updateAccount,
    removeAccount: spies.removeAccount,
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

  it('shows the sign-in and the account in front on the button, and a labelled menu when opened', async () => {
    const { value } = makeCtx();
    const trigger = await openMenu(value);
    expect(trigger.textContent).toContain('Claude');
    expect(trigger.textContent).toContain('Work');
    expect(trigger.getAttribute('aria-expanded')).toBe('true');
    const menu = byRole('menu')!;
    expect(menu.textContent).toContain('Claude accounts');
    expect(menu.textContent).toContain('Every account stays signed in. Choose one to go to its tabs.');
    expect(menu.textContent).not.toContain('One account is signed in at a time');
  });

  it("lists every account as a radio, marks the one in front, and says in words which is the browser's and which still need a sign-in", async () => {
    const { value } = makeCtx();
    await openMenu(value);
    const radios = [...document.querySelectorAll('[role="menuitemradio"]')];
    // The account that used to open in its own window is listed like the others.
    expect(radios.map((r) => r.querySelector('.tk-acct-item-name')?.textContent)).toEqual(['Work', 'Personal', 'Client']);
    expect(radios.map((r) => r.getAttribute('aria-checked'))).toEqual(['true', 'false', 'false']);
    expect(radios[0].textContent).toContain('This browser');
    expect(radios[0].textContent).toContain('work@example.com');
    expect(radios[1].textContent).toContain('Signed in');
    expect(radios[2].textContent).toContain('Sign in');
    expect(radios[2].textContent).toContain('Not signed in yet');
    expect(text()).not.toContain('In their own window');
  });

  it('puts the account the button stands for in front: the given one, else the shown tab\'s', async () => {
    const shown: SessionTab = { id: 't1', provider: 'claude_code', realm: 'anthropic', accountId: PERSONAL.id, url: 'https://claude.ai/code', title: '', threadKey: null, createdAt: 1, lastActiveAt: 1 };
    const { value } = makeCtx({ tabs: [shown], activeTabId: 't1' });
    const trigger = await openMenu(value);
    expect(trigger.textContent).toContain('Personal');
    expect(byRole('menuitemradio', 'Personal')!.getAttribute('aria-checked')).toBe('true');
    act(() => root.unmount());
    root = createRoot(container);
    mount(<AccountMenuButton realmId="anthropic" variant="toolbar" accountId={WINDOWED.id} />, value);
    await press(container.querySelector('button')!);
    expect(byRole('menuitemradio', 'Client')!.getAttribute('aria-checked')).toBe('true');
  });

  it('goes to the chosen account in Browse, announces it, closes the menu and returns focus, without changing any sign-in', async () => {
    const { value, spies } = makeCtx();
    const trigger = await openMenu(value);
    await press(byRole('menuitemradio', 'Personal')!);
    expect(spies.goToAccount).toHaveBeenCalledWith('acct_aaaa');
    expect(spies.setView).toHaveBeenCalledWith('browse');
    expect(spies.announce).toHaveBeenCalledWith('Showing Claude as Personal.');
    expect(spies.useAsBrowserAccount).not.toHaveBeenCalled();
    expect(byRole('menu')).toBeNull();
    expect(document.activeElement).toBe(trigger);
  });

  it('says an account that still needs a sign-in will ask how to sign in', async () => {
    const { value, spies } = makeCtx();
    await openMenu(value);
    await press(byRole('menuitemradio', 'Client')!);
    expect(spies.goToAccount).toHaveBeenCalledWith('acct_bbbb');
    expect(spies.announce).toHaveBeenCalledWith('Client is not signed in to Claude yet. Choose how to sign in.');
  });

  it('keeps the menu open and shows the error when the account cannot be shown', async () => {
    const { value, spies } = makeCtx();
    spies.goToAccount.mockReturnValueOnce({ ok: false, reason: 'no_account', message: 'That account no longer exists.' });
    await openMenu(value);
    await press(byRole('menuitemradio', 'Personal')!);
    expect(byRole('menu')).not.toBeNull();
    expect(byRole('alert')!.textContent).toContain('That account no longer exists.');
    expect(spies.announce).not.toHaveBeenCalled();
    expect(spies.setView).not.toHaveBeenCalled();
  });

  it('shows a busy state while a sign-in of this sign-in is changing, and marks the account signing in', async () => {
    const pending = realms().map((r) =>
      r.realm.id === 'anthropic' ? { ...r, pendingSignIn: { realm: 'anthropic', accountId: WINDOWED.id, returnToAccountId: PRIMARY.id, startedAt: '' } } : r
    );
    const { value } = makeCtx({ realms: pending, busyRealm: 'anthropic' });
    const trigger = await openMenu(value);
    expect(trigger.getAttribute('aria-busy')).toBe('true');
    expect(byRole('menuitemradio', 'Client')!.textContent).toContain('Signing in…');
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

  it('offers the six named colours as one radio group, and nothing about where the account runs', async () => {
    const { value } = makeCtx();
    const { ref } = mountDialog(value);
    await open(ref);
    const groups = [...document.querySelectorAll('#tk-add-account-dialog [role="radiogroup"]')];
    expect(groups).toHaveLength(1);
    expect(groups[0].textContent).toBe('TealPeachVioletSageBlueGold');
    expect(text()).not.toContain('Where it runs');
    expect(text()).not.toContain('Mac helper');
    // Teal, peach and violet are taken by the existing accounts, so the form starts on the next free colour.
    expect((groups[0].querySelector('input:checked') as HTMLInputElement).value).toBe('sage');
  });

  it('says before the button is pressed that nothing is signed out, and how the sign-in happens', async () => {
    const { value } = makeCtx();
    const { ref } = mountDialog(value);
    await open(ref);
    expect(text()).toContain('Nothing is signed out.');
    expect(text()).toContain('Google, Apple or a passkey');
    expect(text()).toContain('encrypted, and never exported or sent anywhere');
    expect(text()).not.toContain('will be signed out');
  });

  it("adds the account after asking for the sign-in's hosts, opens its first tab in Browse and asks how to sign in", async () => {
    const permissions = { request: vi.fn(async () => true) };
    vi.stubGlobal('chrome', { permissions });
    const { value, spies } = makeCtx();
    const { ref, onClosed } = mountDialog(value, 'openai');
    await open(ref);
    type(nameInput(), '  Team  ');
    await press(submit());

    // Only the sign-in host on another domain is asked for, in the click, before the account is added.
    expect(permissions.request).toHaveBeenCalledTimes(1);
    expect(permissions.request).toHaveBeenCalledWith({ origins: ['https://auth.openai.com/*'] });
    expect(spies.addAccount).toHaveBeenCalledWith({ realm: 'openai', mode: 'embedded', label: 'Team', color: 'teal' });
    expect(spies.openUrl).toHaveBeenCalledWith('https://chatgpt.com/', { accountId: 'acct_new', title: 'ChatGPT · Team' });
    expect(spies.setView).toHaveBeenCalledWith('browse');
    expect(spies.announce).toHaveBeenCalledWith('Team was added for ChatGPT. Choose how to sign in to it.');
    expect(ref.current!.hasAttribute('open')).toBe(false);
    expect(onClosed).toHaveBeenCalled();
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

    // Claude needs no extra host to start with; the retry asks for the sign-in's whole set of hosts.
    expect(permissions.request).not.toHaveBeenCalled();
    await press(button('Allow access to Claude and retry', alert));
    expect(permissions.request).toHaveBeenCalledWith({ origins: realmHostOrigins(realmById('anthropic')!) });
    expect(realmHostOrigins(realmById('anthropic')!)).toEqual(['https://*.claude.ai/*']);
    expect(spies.addAccount).toHaveBeenCalledTimes(2);
    expect(spies.openUrl).toHaveBeenCalled();
    expect(ref.current!.hasAttribute('open')).toBe(false);
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
  it('explains how accounts work side by side in the plain facts', () => {
    const { value } = makeCtx();
    mount(<AccountsSettings />, value);
    const t = text();
    expect(t).toContain('How accounts work');
    expect(t).toContain('Nothing is signed out for it');
    expect(t).toContain('encrypted, never exported or sent anywhere');
    expect(t).toContain('can be open at the same moment');
    expect(t).toContain('about 10 KB of cookies per site');
    expect(t).toContain('never sees or stores your passwords');
    expect(t).not.toContain('Only cookies are swapped');
    expect(t).not.toContain('one account of each sign-in is signed in at a time');
  });

  it('shows each account with who it is, whether it is signed in, and where it is used', () => {
    const { value } = makeCtx();
    mount(<AccountsSettings />, value);
    const rows = [...container.querySelectorAll('.tk-acct-row')];
    expect(rows).toHaveLength(3);
    expect(rows[0].textContent).toContain('work@example.com');
    expect(rows[0].textContent).toContain('The account this browser is signed in to');
    expect(rows[0].textContent).toContain('In Threadkeeper and in your ordinary tabs');
    expect(rows[1].textContent).toContain('Identity not seen yet');
    expect(rows[1].textContent).toContain('Signed in. Its sign-in is kept on this device, encrypted.');
    expect(rows[1].textContent).toContain('Inside Threadkeeper only');
    expect(rows[2].textContent).toContain('Not signed in yet');
    expect(rows[2].textContent).not.toContain('own Chrome window');
  });

  it("offers a browser sign-in for each account but the browser's own, and making a signed-in one the browser's", () => {
    const { value } = makeCtx();
    mount(<AccountsSettings />, value);
    const rows = [...container.querySelectorAll<HTMLElement>('.tk-acct-row')];
    const names = (row: HTMLElement) => [...row.querySelectorAll('button')].map((b) => b.textContent ?? '');
    expect(names(rows[0]).some((n) => n.includes('browser tab') || n.includes('browser’s sign-in'))).toBe(false);
    expect(names(rows[1])).toEqual(expect.arrayContaining(['Sign in again with a browser tab', 'Make this the browser’s sign-in']));
    expect(names(rows[2])).toContain('Sign in with a browser tab');
    expect(names(rows[2])).not.toContain('Make this the browser’s sign-in');
  });

  it('starts a browser sign-in for an account and says where to finish it', async () => {
    const { value, spies } = makeCtx();
    mount(<AccountsSettings />, value);
    const client = [...container.querySelectorAll<HTMLElement>('.tk-acct-row')][2];
    await press(button('Sign in with a browser tab', client));
    expect(spies.beginBrowserSignIn).toHaveBeenCalledWith('acct_bbbb');
    expect(spies.announce).toHaveBeenCalledWith('Sign in to Claude as Client in the browser tab that opened.');
  });

  it("asks before making an account the browser's sign-in, and can be talked out of it", async () => {
    const { value, spies } = makeCtx();
    mount(<AccountsSettings />, value);
    const personal = () => [...container.querySelectorAll<HTMLElement>('.tk-acct-row')][1];
    await press(button('Make this the browser’s sign-in', personal()));
    expect(spies.useAsBrowserAccount).not.toHaveBeenCalled();
    expect(personal().textContent).toContain('Every Claude tab changes to this account');
    await press(button('Keep as it is', personal()));
    expect(spies.useAsBrowserAccount).not.toHaveBeenCalled();
    await press(button('Make this the browser’s sign-in', personal()));
    await press(button('Change the browser’s sign-in', personal()));
    expect(spies.useAsBrowserAccount).toHaveBeenCalledWith('acct_aaaa');
    expect(spies.announce).toHaveBeenCalledWith('This browser is now signed in to Claude as Personal.');
  });

  it('keeps those actions unavailable while an account of the sign-in is signing in through the browser', () => {
    const pending = realms().map((r) =>
      r.realm.id === 'anthropic' ? { ...r, pendingSignIn: { realm: 'anthropic', accountId: WINDOWED.id, returnToAccountId: PRIMARY.id, startedAt: '' } } : r
    );
    const { value } = makeCtx({ realms: pending });
    mount(<AccountsSettings />, value);
    const client = [...container.querySelectorAll<HTMLElement>('.tk-acct-row')][2];
    expect(button('Sign in with a browser tab', client).disabled).toBe(true);
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
    expect(steps[0]).toContain('Install Mac Helper.command');
    expect(steps[1]).toContain('every browser on this Mac');
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
    expect(document.querySelector('[data-testid="settings-panel-accounts"]')!.textContent).toContain('How accounts work');
  });

  it('chooses the start page, Claude Code unless changed, or where the person left off', async () => {
    const onPatch = await mountSettings();
    const select = document.querySelector<HTMLSelectElement>('select[aria-describedby="tk-start-page-hint"]')!;
    expect(select.value).toBe('https://claude.ai/code');
    expect([...select.options].map((o) => o.textContent)).toEqual(expect.arrayContaining(['Where I left off', 'Claude Code', 'Claude', 'ChatGPT', 'Codex', 'Grok']));
    expect(document.getElementById('tk-start-page-hint')!.textContent).toContain('Claude Code is also the way in to the rest of Claude');
    await act(async () => {
      select.value = '';
      select.dispatchEvent(new Event('change', { bubbles: true }));
    });
    expect(onPatch).toHaveBeenCalledWith({ startPage: '' });
  });

  it("switches each site's full navigation off and on", async () => {
    const onPatch = await mountSettings();
    const toggle = [...document.querySelectorAll<HTMLInputElement>('label.tk-toggle input')].find((i) =>
      i.parentElement!.textContent!.includes('Show each site’s full navigation')
    )!;
    expect(toggle.checked).toBe(true);
    expect(toggle.parentElement!.textContent).toContain('hide their sidebar and menus');
    await press(toggle);
    expect(onPatch).toHaveBeenCalledWith({ embedFullNavigation: false });
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

describe('Library backups panel', () => {
  const backup = { name: 'library-20260501-120000.tkbackup', bytes: 3 * 1024 * 1024, threads: 412, messages: 9000, createdAt: '2026-05-01T12:00:00Z', extensionVersion: '0.5.0' };
  const stub = (answers: Record<string, unknown>) => {
    vi.stubGlobal('chrome', { permissions: { request: vi.fn(async () => true), contains: vi.fn(async () => true) }, runtime: { id: 'abcdefghijklmnopabcdefghijklmnop' } });
    const send = vi.fn(async (message: { type: string }) => answers[message.type]);
    configureWorkspaceClient({ send: send as never });
    return send;
  };
  const settle = async () => {
    for (let i = 0; i < 5; i++) await act(async () => { await Promise.resolve(); });
  };

  it('offers the backup on disk when the library is empty and restores it', async () => {
    const send = stub({
      BACKUP_STATUS: { ok: true, helper: true, threads: 0, backups: [backup], last: null },
      BACKUP_RESTORE: { ok: true, threadsAdded: 412, kept: 0, settingsRestored: true },
    });
    const { value } = makeCtx();
    mount(<AccountsSettings />, value);
    await settle();
    const offer = container.querySelector('.tk-acct-backup-offer')!;
    expect(offer.textContent).toContain('This library is empty');
    expect(offer.textContent).toContain('412 threads');
    expect((button('Back up now') as HTMLButtonElement).disabled).toBe(true);
    await press(button('Restore that backup', offer as HTMLElement));
    await settle();
    expect(send).toHaveBeenCalledWith({ type: 'BACKUP_RESTORE', name: backup.name });
    expect(container.querySelector('.tk-acct-backup-action')!.textContent).toContain('Restored 412 threads and your settings');
    expect(button('Reload Threadkeeper')).toBeTruthy();
  });

  it('shows the last backup, backs up on request, and confirms before restoring into a library with threads', async () => {
    const send = stub({
      BACKUP_STATUS: { ok: true, helper: true, threads: 500, backups: [backup], last: { fingerprint: 'f', at: '2026-05-01T12:00:00Z', name: backup.name, threads: 412 } },
      BACKUP_NOW: { ok: true, name: 'library-20260502-120000.tkbackup', threads: 500, bytes: 2048 },
      BACKUP_RESTORE: { ok: true, threadsAdded: 0, kept: 412, settingsRestored: false },
    });
    const { value } = makeCtx();
    mount(<AccountsSettings />, value);
    await settle();
    expect(container.querySelector('.tk-acct-backup-offer')).toBeNull();
    expect(container.querySelector('.tk-acct-backups')!.textContent).toContain('Last backup:');
    await press(button('Back up now'));
    await settle();
    expect(send).toHaveBeenCalledWith({ type: 'BACKUP_NOW' });
    expect(container.querySelector('.tk-acct-backup-action')!.textContent).toContain('Backed up 500 threads');
    const row = container.querySelector('.tk-acct-backup-row') as HTMLElement;
    await press(row.querySelector('button')!);
    expect(send).not.toHaveBeenCalledWith({ type: 'BACKUP_RESTORE', name: backup.name });
    expect(row.textContent).toContain('are left as they are');
    await press(button('Restore', row));
    await settle();
    expect(send).toHaveBeenCalledWith({ type: 'BACKUP_RESTORE', name: backup.name });
    expect(container.querySelector('.tk-acct-backup-action')!.textContent).toContain('already has every thread');
  });

  it('says why backups are not being kept', async () => {
    stub({ BACKUP_STATUS: { ok: true, helper: false, reason: 'The Mac helper is not installed for this browser.', threads: 3, backups: [], last: null } });
    const { value } = makeCtx();
    mount(<AccountsSettings />, value);
    await settle();
    expect(container.querySelector('.tk-acct-backups')!.textContent).toContain('Backups are not being kept. The Mac helper is not installed for this browser.');
    expect(container.querySelector('.tk-acct-backup-list')).toBeNull();
  });
});

describe('Restore offer on an empty library', () => {
  const backup = { name: 'library-20260501-120000.tkbackup', bytes: 1024, threads: 412, messages: 9000, createdAt: '2026-05-01T12:00:00Z', extensionVersion: '0.5.0' };
  const settle = async () => {
    for (let i = 0; i < 6; i++) await act(async () => { await Promise.resolve(); });
  };
  const setup = (held: boolean, answers: Record<string, unknown>) => {
    localStorage.clear();
    Object.defineProperty(navigator, 'platform', { value: 'MacIntel', configurable: true });
    const request = vi.fn(async () => true);
    vi.stubGlobal('chrome', { permissions: { request, contains: vi.fn(async () => held) }, runtime: { id: 'abcdefghijklmnopabcdefghijklmnop' } });
    const send = vi.fn(async (message: { type: string }) => answers[message.type]);
    configureWorkspaceClient({ send: send as never });
    return { send, request };
  };
  const banner = () => container.querySelector('[data-testid="restore-offer-banner"]') as HTMLElement | null;

  it('offers the backup at once when the helper is already allowed, and restores it', async () => {
    const { RestoreOfferBanner } = await import('../../src/entrypoints/manager/accounts/RestoreOfferBanner.js');
    const { send } = setup(true, {
      BACKUP_STATUS: { ok: true, helper: true, threads: 0, backups: [backup, { ...backup, name: 'library-20260502-120000.tkbackup', threads: 2 }], last: null },
      BACKUP_RESTORE: { ok: true, threadsAdded: 412, kept: 0, settingsRestored: true },
    });
    mount(<RestoreOfferBanner threads={0} />);
    await settle();
    expect(banner()!.textContent).toContain('holds 412 threads');
    await press(button('Restore', banner()!));
    await settle();
    expect(send).toHaveBeenCalledWith({ type: 'BACKUP_RESTORE', name: backup.name });
    expect(banner()!.textContent).toContain('Restored 412 threads');
    expect(button('Reload Threadkeeper', banner()!)).toBeTruthy();
  });

  it('asks before talking to the helper when this copy has no permission yet', async () => {
    const { RestoreOfferBanner } = await import('../../src/entrypoints/manager/accounts/RestoreOfferBanner.js');
    const { send, request } = setup(false, { BACKUP_STATUS: { ok: true, helper: false, reason: 'The Mac helper is installed, but not for this copy of Threadkeeper.', threads: 0, backups: [], last: null } });
    mount(<RestoreOfferBanner threads={0} />);
    await settle();
    expect(send).not.toHaveBeenCalled();
    expect(banner()!.textContent).toContain('Used Threadkeeper on this Mac before?');
    await press(button('Check for backups', banner()!));
    await settle();
    expect(request).toHaveBeenCalledWith({ permissions: ['nativeMessaging'] });
    expect(banner()!.textContent).toContain('not for this copy of Threadkeeper');
    await press(button('Close', banner()!));
    expect(banner()).toBeNull();
    expect(localStorage.getItem('tk.restoreOffer.dismissed')).toBe('1');
  });

  it('stays out of the way when the library has threads, is still loading, or the offer was dismissed', async () => {
    const { RestoreOfferBanner } = await import('../../src/entrypoints/manager/accounts/RestoreOfferBanner.js');
    const { send } = setup(true, { BACKUP_STATUS: { ok: true, helper: true, threads: 0, backups: [backup], last: null } });
    mount(<RestoreOfferBanner threads={25} />);
    await settle();
    expect(banner()).toBeNull();
    mount(<RestoreOfferBanner threads={null} />);
    await settle();
    expect(banner()).toBeNull();
    localStorage.setItem('tk.restoreOffer.dismissed', '1');
    mount(<RestoreOfferBanner threads={0} />);
    await settle();
    expect(banner()).toBeNull();
    expect(send).not.toHaveBeenCalled();
  });
});

