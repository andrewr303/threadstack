// What a slot shows while its page is not on screen: its account still has to sign in, another
// account holds the place this one loads in, a sign-in is open in a browser tab, the site needs
// host access, or the page is still loading. Used by Browse, the Threads live pane and the
// Dashboard panes, so the wording is the same everywhere.
import React, { useEffect, useState } from 'react';
import type { ProviderId } from '../../../core/providers.js';
import type { SessionTab } from '../../../core/workspace/types.js';
import { Notice, realmNameFor } from '../shell/primitives.js';
import { useEmbedAccess } from './access.js';
import { useWorkspaceContext } from './context.js';
import { findAccount } from './state.js';

/** How long a page may stay blank before the slot offers a way out. */
const SLOW_LOAD_MS = 12_000;

function hostOf(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return 'the page';
  }
}

export function RestingPage({
  tab,
  /** What the slot is called in sentences: "tab" in Browse, "pane" in Dashboard, "page" in Threads. */
  noun = 'tab',
}: {
  tab: SessionTab;
  noun?: 'tab' | 'pane' | 'page';
}) {
  const { workspace, settings, patchSettings, openInChromeTab, announce } = useWorkspaceContext();
  const rest = workspace.plan.resting[tab.id];
  const live = workspace.plan.live.includes(tab.id);
  const runtime = workspace.runtime(tab.id);
  const provider = tab.provider as ProviderId | null;
  const { access, allow } = useEmbedAccess(provider, settings, patchSettings);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const [slow, setSlow] = useState(false);

  useEffect(() => {
    setSlow(false);
    if (!live || runtime.loaded) return;
    const timer = setTimeout(() => setSlow(true), SLOW_LOAD_MS);
    return () => clearTimeout(timer);
  }, [live, runtime.loaded, runtime.reloads, tab.id]);

  // A message about one state does not belong to the next.
  useEffect(() => setProblem(null), [rest, tab.id]);

  const realmName = realmNameFor(provider);
  const account = findAccount(workspace.realms, tab.accountId);
  const name = account?.label ?? 'This account';
  const entry = workspace.realms.find((r) => r.realm.id === tab.realm);
  const browserAccount = entry ? findAccount(workspace.realms, entry.activeAccountId ?? '') : null;
  const realmBusy = workspace.busyRealm === tab.realm;

  /** Run an account action from a button: one at a time, with its failure shown in the notice. */
  const run = async (work: () => Promise<{ ok: boolean; error?: string }>, done?: string) => {
    setBusy(true);
    setProblem(null);
    const result = await work();
    setBusy(false);
    if (result.ok) {
      if (done) announce(done);
    } else {
      setProblem(result.error ?? 'That did not work. Try again.');
    }
  };

  if (!workspace.ready) return <Notice title="Starting the workspace…" />;

  if (!workspace.embedding) {
    return (
      <Notice icon="alert" tone="warn" title="Pages cannot be shown here right now" actions={
        <button type="button" className="tk-btn tk-btn-primary" onClick={() => openInChromeTab(tab.url)}>Open in Chrome tab</button>
      }>
        <p>{workspace.error ?? 'Threadkeeper could not prepare this tab for embedded pages.'}</p>
      </Notice>
    );
  }

  if (access === 'needed') {
    return (
      <Notice icon="lock" title={`Allow ${hostOf(tab.url)} to open here`} actions={
        <>
          <button
            type="button"
            className="tk-btn tk-btn-primary"
            disabled={busy}
            onClick={async () => {
              setBusy(true);
              const ok = await allow();
              setBusy(false);
              if (ok) workspace.reload(tab.id);
              else setProblem('Chrome did not grant access. Nothing was changed.');
            }}
          >
            Allow access
          </button>
          <button type="button" className="tk-btn" onClick={() => openInChromeTab(tab.url)}>Open in Chrome tab</button>
        </>
      }>
        <p>Threadkeeper needs your permission for this site before it can show its pages and save its sessions.</p>
        {problem && <p role="alert">{problem}</p>}
      </Notice>
    );
  }

  if (rest === 'pending') {
    const pending = entry?.pendingSignIn ?? null;
    const signingIn = pending ? findAccount(workspace.realms, pending.accountId) : null;
    const who = signingIn?.label ?? 'an account';
    const mine = pending?.accountId === tab.accountId;
    return (
      <Notice icon="userPlus" title={mine ? `Sign in to ${who} in the browser tab` : `${realmName} is waiting for a sign-in`}>
        <p>
          {mine
            ? 'Use the sign-in controls at the top of Threadkeeper to reopen the browser tab, finish, or cancel.'
            : `${who} is signing in to ${realmName} in a browser tab. Until that ends, ${realmName} pages wait here.`}
        </p>
        <p className="tk-notice-note">
          Your browser’s own {realmName} sign-in is set aside meanwhile and put back when the sign-in ends.
        </p>
        {problem && <p role="alert">{problem}</p>}
      </Notice>
    );
  }

  if (rest === 'signin') {
    const preferBrowser = entry?.realm.preferBrowserSignIn === true;
    const embeddedSignIn = (
      <button
        type="button"
        className={preferBrowser ? 'tk-btn' : 'tk-btn tk-btn-primary'}
        disabled={busy || !account}
        onClick={async () => {
          setBusy(true);
          await workspace.showProfile(tab.accountId);
          setBusy(false);
        }}
      >
        Sign in here
      </button>
    );
    const browserSignIn = (
      <button
        type="button"
        className={preferBrowser ? 'tk-btn tk-btn-primary' : 'tk-btn'}
        disabled={busy || realmBusy || !account}
        onClick={() => void run(() => workspace.beginBrowserSignIn(tab.accountId))}
      >
        Sign in with a browser tab
      </button>
    );
    return (
      <Notice icon="userPlus" title={`${name} is not signed in to ${realmName} yet`} actions={
        preferBrowser ? <>{browserSignIn}{embeddedSignIn}</> : <>{embeddedSignIn}{browserSignIn}</>
      }>
        <p>
          {preferBrowser
            ? `Use a browser tab for ${realmName}’s sign-in and choose the account you want to add when prompted.`
            : `“Sign in here” opens ${realmName}’s sign-in page in this ${noun}. Your other ${realmName} account stays signed in beside it.`}
        </p>
        <p className="tk-notice-note">
          Use a browser tab if your sign-in goes through Google, Apple, a passkey or a pop-up window. Threadkeeper sets your
          browser’s own {realmName} sign-in aside while you sign in, then puts it back.
        </p>
        {!workspace.profilesSaved && (
          <p className="tk-notice-note" role="status">
            This build cannot save the sign-in yet. Reload the extension from the browser’s extensions page first.
          </p>
        )}
        {problem && <p role="alert">{problem}</p>}
      </Notice>
    );
  }

  if (rest === 'profile') {
    const holder = findAccount(workspace.realms, workspace.slots[tab.realm]?.accountId ?? '');
    const shown = [browserAccount?.label, holder?.label].filter(Boolean).join(' and ');
    return (
      <Notice icon="swap" title={`Show ${name} here?`} actions={
        <button type="button" className="tk-btn tk-btn-primary" disabled={busy || !account} onClick={() => void workspace.switchProfile(tab.id)}>
          Switch to {name}
        </button>
      }>
        <p>
          This window shows two {realmName} accounts at a time{shown ? `, now ${shown}` : ''}. Switching to {name} reloads
          Threadkeeper’s pages; nothing is signed out.
        </p>
      </Notice>
    );
  }

  if (rest === 'seeding') return <Notice title={`Loading ${name}…`} />;

  if (rest === 'stale') {
    return (
      <Notice icon="swap" title={workspace.slots[tab.realm]?.moved ? `${name} moved to another Threadkeeper tab` : `${name}’s sign-in changed`} actions={
        <button type="button" className="tk-btn tk-btn-primary" disabled={!account} onClick={() => void workspace.switchProfile(tab.id)}>
          Reload to show {name}
        </button>
      }>
        <p>
          {workspace.slots[tab.realm]?.moved
            ? 'Reload this tab if you want to move the account back.'
            : `Reload Threadkeeper to use the latest saved sign-in for ${name}.`}
        </p>
      </Notice>
    );
  }

  if (rest === 'failed') {
    const slot = workspace.slots[tab.realm];
    if (slot?.inUse) {
      return (
        <Notice icon="swap" title={`${name} is open in another Threadkeeper tab`} actions={
          <button type="button" className="tk-btn tk-btn-primary" disabled={busy} onClick={async () => {
            setBusy(true);
            await workspace.showProfile(tab.accountId, true);
            setBusy(false);
          }}>
            Move account here
          </button>
        }>
          <p>This tab takes over the saved sign-in and the account’s pages pause in the other tab.</p>
        </Notice>
      );
    }
    return (
      <Notice icon="alert" tone="warn" title={`${name} could not be loaded`} actions={
        <>
          <button
            type="button"
            className="tk-btn tk-btn-primary"
            disabled={busy}
            onClick={async () => {
              setBusy(true);
              await workspace.showProfile(tab.accountId);
              setBusy(false);
            }}
          >
            Try again
          </button>
          <button type="button" className="tk-btn" onClick={() => openInChromeTab(tab.url)}>Open in Chrome tab</button>
        </>
      }>
        <p>{slot?.error ?? 'Threadkeeper could not put this account’s sign-in in place.'}</p>
      </Notice>
    );
  }

  if (live && !runtime.loaded) {
    return slow ? (
      <Notice icon="alert" title={`${hostOf(tab.url)} is taking a while`} actions={
        <>
          <button type="button" className="tk-btn tk-btn-primary" onClick={() => workspace.reload(tab.id)}>Reload</button>
          <button type="button" className="tk-btn" onClick={() => openInChromeTab(tab.url)}>Open in Chrome tab</button>
        </>
      }>
        <p>If the page needs a sign-in step that cannot run inside Threadkeeper, finish it in a Chrome tab, then reload here.</p>
      </Notice>
    ) : (
      <Notice title={`Loading ${hostOf(tab.url)}…`} />
    );
  }

  // Asleep and about to load, or loaded and covered by the page itself.
  return null;
}
