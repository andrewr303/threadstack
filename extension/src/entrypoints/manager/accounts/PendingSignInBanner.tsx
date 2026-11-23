// Shown above every view while an account is signing in through a browser tab: the browser's
// own sign-in for that site is set aside until this ends, so the way to end it must be reachable
// from wherever the person is, not only from a tab of that site.
import React, { useEffect, useState } from 'react';
import { signInAttemptId } from '../../../core/workspace/types.js';
import { workspaceApi } from '../workspace/client.js';
import { useWorkspaceContext } from '../workspace/context.js';
import { findAccount } from '../workspace/state.js';
import { useMounted } from './common.js';

export function PendingSignInBanner() {
  const { workspace, announce } = useWorkspaceContext();
  const mounted = useMounted();
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);

  const entry = workspace.realms.find((r) => r.pendingSignIn) ?? null;
  const attemptId = entry?.pendingSignIn ? signInAttemptId(entry.pendingSignIn) : null;
  useEffect(() => setProblem(null), [attemptId, entry?.pendingSignIn?.wrongAccount]);
  if (!workspace.enabled || !entry?.pendingSignIn) return null;
  const pending = entry.pendingSignIn;
  const realmName = entry.realm.label;
  const who = findAccount(workspace.realms, entry.pendingSignIn.accountId)?.label ?? 'an account';

  const act = async (action: 'open' | 'finish' | 'cancel') => {
    setBusy(true);
    setProblem(null);
    const id = signInAttemptId(pending);
    const result = await (action === 'open'
      ? workspaceApi.resumeBrowserSignIn(id)
      : action === 'finish'
        ? workspace.finishBrowserSignIn(id)
        : workspace.cancelBrowserSignIn(id));
    if (!mounted.current) return;
    setBusy(false);
    if (!result.ok) {
      setProblem(result.error);
    } else if (action !== 'open') {
      announce(
        action === 'finish'
          ? `${who} is signed in. Your browser's own ${realmName} sign-in is back.`
          : `Sign-in cancelled. Your browser's own ${realmName} sign-in is back.`
      );
    }
  };

  return (
    <div className="tk-banner" role="status" data-testid="pending-signin-banner">
      <div className="tk-banner-body">
        <strong>
          Signing in to {realmName} as {who}
        </strong>
        <span>
          {pending.wrongAccount
            ? 'The site picked a different saved account. Choose the account you want in the sign-in tab, or cancel.'
            : `Finish in the sign-in tab. Threadkeeper restores your browser’s usual ${realmName} account afterwards.`}
        </span>
        {problem && <span role="alert">{problem}</span>}
      </div>
      <button type="button" className="tk-btn" disabled={busy} onClick={() => void act('open')}>
        Open sign-in tab
      </button>
      <button type="button" className="tk-btn tk-btn-primary" disabled={busy || pending.wrongAccount} onClick={() => void act('finish')}>
        I’ve signed in
      </button>
      <button type="button" className="tk-btn" disabled={busy} onClick={() => void act('cancel')}>
        Cancel sign-in
      </button>
    </div>
  );
}
