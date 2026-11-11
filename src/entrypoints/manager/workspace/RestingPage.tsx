// What a slot shows while its page is not on screen: paused for another account, living in its
// own Chrome window, waiting for host access, or still loading. Used by Browse, the Threads
// live pane and the Dashboard panes, so the wording is the same everywhere.
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

  const realmName = realmNameFor(provider);
  const account = findAccount(workspace.realms, tab.accountId);
  const entry = workspace.realms.find((r) => r.realm.id === tab.realm);
  const signedIn = entry ? findAccount(workspace.realms, entry.activeAccountId ?? '') : null;

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

  if (rest === 'isolated') {
    return (
      <Notice icon="window" title={`${account?.label ?? 'This account'} opens in its own Chrome window`} actions={
        <button
          type="button"
          className="tk-btn tk-btn-primary"
          disabled={busy}
          onClick={async () => {
            setBusy(true);
            const res = await workspace.openIsolated(tab.accountId, tab.url);
            setBusy(false);
            setProblem(res.ok ? null : res.error);
            if (res.ok) announce(`Opened in the ${account?.label ?? 'account'} window.`);
          }}
        >
          Open its window
        </button>
      }>
        <p>That keeps it signed in at the same time as your other {realmName} account.</p>
        {problem && <p role="alert">{problem}</p>}
      </Notice>
    );
  }

  if (rest === 'account') {
    const target = account?.label ?? 'that account';
    return (
      <Notice icon="pause" title={`This ${noun} is paused`} actions={
        <button
          type="button"
          className="tk-btn tk-btn-primary"
          disabled={busy || workspace.switchingRealm === tab.realm || !account}
          onClick={async () => {
            setBusy(true);
            const res = await workspace.switchAccount(tab.accountId);
            setBusy(false);
            setProblem(res.ok ? null : res.error);
            if (res.ok) announce(`${realmName} is now signed in as ${target}.`);
          }}
        >
          Switch account
        </button>
      }>
        <p>
          {realmName} is signed in as {signedIn?.label ?? 'another account'}. Switch to {target} to use this {noun}.
        </p>
        <p className="tk-notice-note">Switching reloads your {realmName} tabs, here and in the rest of Chrome.</p>
        {problem && <p role="alert">{problem}</p>}
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
