// Second row of the Browse bar: back, forward, reload, the address, the account switcher,
// "Open in Chrome tab" and the Summary toggle.
import React, { useRef, useState } from 'react';
import type { SessionTab } from '../../../core/workspace/types.js';
import { AccountMenuButton } from '../accounts/AccountMenu.js';
import { Icon } from '../shell/icons.js';
import { useWorkspaceContext } from '../workspace/context.js';
import { resolveAddress, splitAddress } from './address.js';

export interface AddressNotice {
  message: string;
  /** Address Chrome can open instead, when there is one. */
  chromeUrl: string | null;
}

function AddressField({
  tab,
  onNotice,
}: {
  tab: SessionTab | null;
  onNotice: (notice: AddressNotice | null) => void;
}) {
  const { workspace, announce } = useWorkspaceContext();
  const inputRef = useRef<HTMLInputElement>(null);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState('');
  const current = tab?.url ?? '';
  const { host, rest } = splitAddress(current);

  const submit = (event: React.FormEvent) => {
    event.preventDefault();
    if (!tab) return;
    const outcome = resolveAddress(draft, tab);
    if (outcome.kind === 'none') {
      inputRef.current?.blur();
      return;
    }
    if (outcome.kind === 'refuse') {
      onNotice({ message: outcome.message, chromeUrl: outcome.chromeUrl });
      announce(outcome.message);
      return;
    }
    const result = outcome.kind === 'navigate' ? workspace.navigate(tab.id, outcome.url) : workspace.openUrl(outcome.url);
    if (!result.ok) {
      onNotice({ message: result.message, chromeUrl: outcome.url });
      announce(result.message);
      return;
    }
    onNotice(null);
    announce(`Opening ${splitAddress(outcome.url).host}`);
    inputRef.current?.blur();
  };

  return (
    <form className="tk-browse-addr" data-editing={editing ? 'true' : 'false'} onSubmit={submit}>
      <Icon name="lock" size={13} className="tk-browse-addr-lock" />
      <span className="tk-browse-addr-view" aria-hidden="true">
        {tab ? (
          <>
            <b className="tk-browse-addr-host">{host}</b>
            <span className="tk-browse-addr-path">{rest}</span>
          </>
        ) : null}
      </span>
      <input
        ref={inputRef}
        className="tk-browse-addr-input"
        type="text"
        inputMode="url"
        spellCheck={false}
        autoComplete="off"
        autoCapitalize="off"
        aria-label="Address"
        placeholder={tab ? undefined : 'Choose a provider and account below'}
        disabled={!tab}
        title={current || undefined}
        value={editing ? draft : current}
        onChange={(event) => setDraft(event.target.value)}
        onFocus={(event) => {
          setDraft(current);
          setEditing(true);
          event.currentTarget.select();
        }}
        onBlur={() => setEditing(false)}
        onKeyDown={(event) => {
          if (event.key !== 'Escape') return;
          event.preventDefault();
          event.stopPropagation();
          setDraft(current);
          onNotice(null);
          event.currentTarget.select();
        }}
      />
    </form>
  );
}

export function Toolbar({
  tab,
  summaryOpen,
  summaryId,
  summaryButtonRef,
  onToggleSummary,
  onNotice,
}: {
  /** The tab in the stage; null on the new tab page, where the controls rest. */
  tab: SessionTab | null;
  summaryOpen: boolean;
  summaryId: string;
  summaryButtonRef: React.RefObject<HTMLButtonElement>;
  onToggleSummary: () => void;
  onNotice: (notice: AddressNotice | null) => void;
}) {
  const { workspace, openInChromeTab } = useWorkspaceContext();
  const loaded = tab ? workspace.plan.live.includes(tab.id) : false;
  const runtime = tab ? workspace.runtime(tab.id) : null;
  return (
    <div className="tk-browse-row tk-browse-toolbar">
      <button
        type="button"
        className="tk-icon-btn"
        aria-label="Back"
        title="Back"
        disabled={!tab || !loaded || !runtime?.canGoBack}
        onClick={() => tab && workspace.back(tab.id)}
      >
        <Icon name="back" />
      </button>
      <button
        type="button"
        className="tk-icon-btn"
        aria-label="Forward"
        title="Forward"
        disabled={!tab || !loaded || !runtime?.canGoForward}
        onClick={() => tab && workspace.forward(tab.id)}
      >
        <Icon name="forward" />
      </button>
      <button
        type="button"
        className="tk-icon-btn"
        aria-label="Reload"
        title="Reload"
        disabled={!tab || !loaded}
        onClick={() => tab && workspace.reload(tab.id)}
      >
        <Icon name="reload" />
      </button>
      <AddressField key={tab?.id ?? 'none'} tab={tab} onNotice={onNotice} />
      {tab && (
        <>
          <AccountMenuButton realmId={tab.realm} variant="toolbar" />
          <button
            type="button"
            className="tk-btn tk-btn-quiet tk-browse-chrome-btn"
            aria-label="Open in Chrome tab"
            onClick={() => openInChromeTab(tab.url)}
          >
            <Icon name="external" />
            <span className="tk-browse-btn-label">Open in Chrome tab</span>
          </button>
          <button
            type="button"
            ref={summaryButtonRef}
            className="tk-btn tk-browse-summary-btn"
            aria-label="Summary"
            aria-pressed={summaryOpen}
            aria-controls={summaryOpen ? summaryId : undefined}
            onClick={onToggleSummary}
          >
            <Icon name="summary" />
            <span className="tk-browse-btn-label">Summary</span>
          </button>
        </>
      )}
    </div>
  );
}
