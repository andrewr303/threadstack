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
      <Notice icon="userPlus" title={mine ? `Sign in to ${who} in the browser tab that opened` : `${realmName} is waiting for a sign-in`} actions={
        <>
          <button
            type="button"
            className="tk-btn tk-btn-primary"
            disabled={busy || realmBusy}
            onClick={() => void run(() => workspace.finishBrowserSignIn(), `${who} is signed in. Your browser's own ${realmName} sign-in is back.`)}
          >
            I’ve signed in
          </button>
          <button
            type="button"
            className="tk-btn"
            disabled={busy || realmBusy}
            onClick={() => void run(() => workspace.cancelBrowserSignIn(), `Sign-in cancelled. Your browser's own ${realmName} sign-in is back.`)}
          >
            Cancel sign-in
          </button>
        </>
      }>
        <p>
          {mine
            ? `Finish signing in to ${realmName} as ${who} there. Threadkeeper notices when you are in and brings you back; if it does not, choose “I’ve signed in”.`
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
    return (
      <Notice icon="userPlus" title={`${name} is not signed in to ${realmName} yet`} actions={
        <>
          <button
            type="button"
            className="tk-btn tk-btn-primary"
            disabled={busy || !account}
            onClick={async () => {
              setBusy(true);
              await workspace.showProfile(tab.accountId);
              setBusy(false);
            }}
          >
            Sign in here
          </button>
          <button
            type="button"
            className="tk-btn"
            disabled={busy || realmBusy || !account}
            onClick={() => void run(() => workspace.beginBrowserSignIn(tab.accountId))}
          >
            Sign in with a browser tab
          </button>
        </>
      }>
        <p>
          “Sign in here” opens {realmName}’s sign-in page in this {noun}; your other {realmName} account stays signed in beside it.
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
      <Notice icon="swap" title={`${name}’s sign-in changed`} actions={
        <button type="button" className="tk-btn tk-btn-primary" disabled={!account} onClick={() => void workspace.switchProfile(tab.id)}>
          Reload to show {name}
        </button>
      }>
        <p>
          Threadkeeper saved a newer sign-in for {name} than the one this window loaded. Reloading Threadkeeper’s pages shows
          it; nothing is signed out.
        </p>
      </Notice>
    );
  }

  if (rest === 'failed') {
    const slot = workspace.slots[tab.realm];
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
