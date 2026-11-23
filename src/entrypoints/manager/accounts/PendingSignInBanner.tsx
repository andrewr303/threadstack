// Shown above every view while an account is signing in through a browser tab: the browser's
// own sign-in for that site is set aside until this ends, so the way to end it must be reachable
// from wherever the person is, not only from a tab of that site.
import React, { useState } from 'react';
import { useWorkspaceContext } from '../workspace/context.js';
import { findAccount } from '../workspace/state.js';
import { useMounted } from './common.js';

export function PendingSignInBanner() {
  const { workspace, announce } = useWorkspaceContext();
  const mounted = useMounted();
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);

  const entry = workspace.realms.find((r) => r.pendingSignIn) ?? null;
  if (!workspace.enabled || !entry?.pendingSignIn) return null;
  const realmName = entry.realm.label;
  const who = findAccount(workspace.realms, entry.pendingSignIn.accountId)?.label ?? 'an account';

  const end = async (keep: boolean) => {
    setBusy(true);
    setProblem(null);
    const result = keep ? await workspace.finishBrowserSignIn() : await workspace.cancelBrowserSignIn();
    if (!mounted.current) return;
    setBusy(false);
    if (result.ok) {
      announce(
        keep
          ? `${who} is signed in. Your browser's own ${realmName} sign-in is back.`
          : `Sign-in cancelled. Your browser's own ${realmName} sign-in is back.`
      );
    } else {
      setProblem(result.error);
    }
  };

  return (
    <div className="tk-banner" role="status" data-testid="pending-signin-banner">
      <div className="tk-banner-body">
        <strong>
          Signing in to {realmName} as {who}
        </strong>
        <span>
          Finish in the browser tab that opened. Your browser’s own {realmName} sign-in is set aside until then and put back
          afterwards.
        </span>
        {problem && <span role="alert">{problem}</span>}
      </div>
      <button type="button" className="tk-btn tk-btn-primary" disabled={busy} onClick={() => void end(true)}>
        I’ve signed in
      </button>
      <button type="button" className="tk-btn" disabled={busy} onClick={() => void end(false)}>
        Cancel sign-in
      </button>
    </div>
  );
}
