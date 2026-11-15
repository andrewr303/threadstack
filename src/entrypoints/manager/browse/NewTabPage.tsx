// The page shown in the stage when no tab is open or the new-tab button was pressed: pick a
// provider and the account to use, or go back to one of the most recent sessions.
import React, { forwardRef, useId, useMemo } from 'react';
import { realmForProvider } from '../../../core/workspace/realms.js';
import type { AccountRecord } from '../../../core/workspace/types.js';
import { providerCategory } from '../../../core/providers.js';
import { AccountChip, ProviderMark, RunState, providerName } from '../shell/primitives.js';
import { useWorkspaceContext } from '../workspace/context.js';
import { launchSections, type LaunchProvider } from '../workspace/launch.js';
import { embedTargetFor, needsSignIn } from '../workspace/state.js';
import { relativeTime } from './format.js';

const RECENT_COUNT = 8;

function ProviderCard({ entry, onOpen }: { entry: LaunchProvider; onOpen: (url: string, accountId?: string) => void }) {
  const { workspace } = useWorkspaceContext();
  const nameId = useId();
  const name = providerName(entry.provider);
  const realm = realmForProvider(entry.provider);
  const group = realm ? workspace.realms.find((r) => r.realm.id === realm.id) : undefined;
  const accounts: AccountRecord[] = group?.accounts ?? [];
  const several = accounts.length > 1;
  return (
    <li className="tk-browse-prov" role="group" aria-labelledby={nameId}>
      <ProviderMark provider={entry.provider} />
      <div className="tk-browse-prov-body">
        <div className="tk-browse-prov-name" id={nameId}>{name}</div>
        <div className="tk-browse-prov-actions">
          {several ? (
            accounts.map((account) => {
              const browser = account.id === group?.activeAccountId;
              const signedIn = browser || !needsSignIn(account);
              return (
                <button key={account.id} type="button" className="tk-btn" onClick={() => onOpen(entry.url, account.id)}>
                  <span className="tk-acct" data-color={account.color} data-active={signedIn ? 'true' : 'false'} aria-hidden="true">
                    <span className="tk-acct-dot" />
                  </span>
                  <span>Open as {account.label}</span>
                  {!signedIn && <small className="tk-browse-prov-note">not signed in yet</small>}
                </button>
              );
            })
          ) : (
            <button type="button" className="tk-btn" onClick={() => onOpen(entry.url, accounts[0]?.id)}>
              Open
            </button>
          )}
        </div>
      </div>
    </li>
  );
}

export const NewTabPage = forwardRef<
  HTMLDivElement,
  { onOpen: (url: string, accountId?: string) => void }
>(function NewTabPage({ onOpen }, ref) {
  const { conversations, accountOfThread, openSession } = useWorkspaceContext();
  const sections = useMemo(() => launchSections(), []);
  const recent = useMemo(
    () =>
      conversations
        .filter((conv) => embedTargetFor(conv.canonicalUrl) !== null)
        .sort((a, b) => Date.parse(b.lastCapturedAt) - Date.parse(a.lastCapturedAt))
        .slice(0, RECENT_COUNT),
    [conversations]
  );
  return (
    <div ref={ref} className="tk-browse-launch" role="region" aria-label="New tab" tabIndex={-1}>
      <div className="tk-browse-launch-in">
        <div className="tk-browse-launch-main">
          <h2 className="tk-browse-launch-title">Open a session</h2>
          <p className="tk-browse-launch-sub">
            Pick a provider and the account to use. Accounts of the same provider stay signed in side by side.
          </p>
          {sections.map((section) => (
            <section key={section.group} className="tk-browse-launch-group" aria-label={section.label}>
              <h3 className="tk-eyebrow">{section.label}</h3>
              <ul className="tk-browse-prov-list">
                {section.providers.map((entry) => (
                  <ProviderCard key={entry.provider} entry={entry} onOpen={onOpen} />
                ))}
              </ul>
            </section>
          ))}
        </div>
        <aside className="tk-browse-launch-side" aria-label="Recent sessions">
          <h3 className="tk-eyebrow">Recent sessions</h3>
          {recent.length === 0 ? (
            <p className="tk-browse-launch-note">
              No sessions are saved yet. Threadkeeper saves a session by itself once its page shows a conversation.
            </p>
          ) : (
            <ul className="tk-browse-recent">
              {recent.map((conv) => {
                const { account, active } = accountOfThread(conv);
                const when = relativeTime(conv.lastCapturedAt);
                const title = conv.manualTitleOverride || conv.title;
                return (
                  <li key={conv.threadKey}>
                    <button type="button" className="tk-browse-recent-row" onClick={() => openSession(conv, 'browse')}>
                      <ProviderMark provider={conv.provider} />
                      <span className="tk-browse-recent-text">
                        <span className="tk-browse-recent-title">{title}</span>
                        <span className="tk-browse-recent-meta">
                          <span>{providerName(conv.provider)}</span>
                          <AccountChip account={account} active={active} />
                          {providerCategory(conv.provider) === 'coding_agent' && (
                            <RunState state={conv.agentState} observedAt={conv.agentStateAt} />
                          )}
                          {when && <span className="tk-muted">{when}</span>}
                        </span>
                      </span>
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
          <p className="tk-browse-launch-note">Sessions are saved automatically while you work in them.</p>
        </aside>
      </div>
    </div>
  );
});
