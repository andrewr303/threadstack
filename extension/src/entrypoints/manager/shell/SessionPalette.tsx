// The session palette (⌘K / Ctrl+K, the rail's search button, the address field's ⌘K chip): find
// any session by what it is about or by its account, narrow by run state or kind, and open it in
// Browse. A query that is an address is offered first and opens through the address rules of
// the Browse bar. A modal <dialog> in the browser's top layer, like the other dialogs; the rules
// live in palette.ts.
import React, { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react';
import type { ConversationRecord } from '../../../core/schema.js';
import type { AgentState } from '../../../core/workspace/types.js';
import { openModal } from '../shared.js';
import { useWorkspaceContext } from '../workspace/context.js';
import { SESSION_GROUP_LABELS } from '../workspace/state.js';
import { Icon } from './icons.js';
import {
  PALETTE_FILTERS,
  PALETTE_RENDER_LIMIT,
  clampSelection,
  filterPalette,
  moveSelection,
  paletteAddress,
  paletteCounts,
  paletteEligible,
  paletteMatches,
  toPaletteSession,
  type PaletteAddress,
  type PaletteFilter,
  type PaletteSession,
} from './palette.js';
import { AccountChip, ProviderMark, RunState } from './primitives.js';

export interface SessionPaletteProps {
  dialogRef: React.MutableRefObject<HTMLDialogElement | null>;
  /** Whether the palette is showing. The owner sets it; `onClose` reports every way it closes. */
  open: boolean;
  onClose: () => void;
  /** The library search (best match first). Without it, titles are matched as plain text. */
  search?: (query: string) => readonly ConversationRecord[];
}

type PaletteRow = { kind: 'address'; address: PaletteAddress } | { kind: 'session'; session: PaletteSession };

const FOCUSABLE = 'input:not([disabled]), button:not([disabled]), [tabindex]:not([tabindex="-1"])';

export function SessionPalette({ dialogRef, open, onClose, search }: SessionPaletteProps) {
  const { workspace, conversations, accountOfThread, openSession, setView, openInChromeTab, announce } = useWorkspaceContext();
  const ids = useId().replace(/:/g, '');
  const titleId = `${ids}-title`;
  const listId = `${ids}-list`;
  const optionId = (index: number) => `${ids}-opt-${index}`;
  const inputRef = useRef<HTMLInputElement>(null);
  const returnFocus = useRef<HTMLElement | null>(null);
  const [query, setQuery] = useState('');
  const [filter, setFilter] = useState<PaletteFilter>('all');
  const [selected, setSelected] = useState(0);
  const [problem, setProblem] = useState<string | null>(null);

  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;
  const accountRef = useRef(accountOfThread);
  accountRef.current = accountOfThread;

  /** Every way the palette closes ends here: reset it, tell the owner, give focus back. */
  const finish = useCallback(() => {
    setQuery('');
    setFilter('all');
    setSelected(0);
    setProblem(null);
    onCloseRef.current();
    const back = returnFocus.current;
    returnFocus.current = null;
    if (back?.isConnected) back.focus({ preventScroll: true });
  }, []);

  const requestClose = useCallback(() => {
    const el = dialogRef.current;
    if (el && typeof el.close === 'function' && el.open) {
      el.close(); // the dialog's close event calls finish()
      return;
    }
    el?.removeAttribute('open');
    finish();
  }, [dialogRef, finish]);

  // The owner opens and closes it; opening remembers where focus was and moves it to the input.
  useEffect(() => {
    const el = dialogRef.current;
    if (!el) return;
    const showing = el.open || el.hasAttribute('open');
    if (open && !showing) {
      const active = document.activeElement;
      returnFocus.current = active instanceof HTMLElement && active !== document.body ? active : null;
      openModal(dialogRef);
      inputRef.current?.focus({ preventScroll: true });
    } else if (!open && showing) {
      requestClose();
    }
  }, [open, dialogRef, requestClose]);

  // Live run states: a page open in the workspace reports its own, newer than the stored one.
  const liveRuns = new Map<string, AgentState | null>();
  for (const tab of workspace.state.tabs) {
    if (!tab.threadKey) continue;
    const state = workspace.runtime(tab.id).agentState ?? null;
    if (state) liveRuns.set(tab.threadKey, state);
  }
  const liveKey = [...liveRuns].map(([k, v]) => `${k}=${v}`).join('|');

  const total = useMemo(() => conversations.filter(paletteEligible).length, [conversations]);
  const matches = useMemo(
    () =>
      open
        ? paletteMatches({
            query,
            conversations,
            search,
            accountLabelOf: (conv) => accountRef.current(conv).account?.label ?? null,
          })
        : [],
    [open, query, conversations, search]
  );
  const sessions = useMemo(
    () => matches.map((conv) => toPaletteSession(conv, liveRuns.get(conv.threadKey))),
    // liveKey stands for liveRuns, which is rebuilt every render.
    [matches, liveKey]
  );
  const counts = useMemo(() => paletteCounts(sessions), [sessions]);
  const filtered = useMemo(() => filterPalette(sessions, filter), [sessions, filter]);
  const address = useMemo(() => (open ? paletteAddress(query) : null), [open, query]);
  const rows: PaletteRow[] = useMemo(
    () => [
      ...(address ? [{ kind: 'address', address } as const] : []),
      ...filtered.slice(0, PALETTE_RENDER_LIMIT).map((session) => ({ kind: 'session', session }) as const),
    ],
    [address, filtered]
  );
  const current = clampSelection(selected, rows.length);

  // The chosen row stays in view while the arrows move it.
  useEffect(() => {
    if (!open || current < 0) return;
    const el = document.getElementById(optionId(current));
    el?.scrollIntoView?.({ block: 'nearest' });
  }, [open, current]);

  const activate = (row: PaletteRow | undefined) => {
    if (!row) return;
    if (row.kind === 'session') {
      const conv = row.session.conversation;
      requestClose();
      openSession(conv, 'browse');
      return;
    }
    const { address: target } = row;
    if (target.kind === 'chrome') {
      requestClose();
      openInChromeTab(target.url);
      announce(`Opened ${target.host} in a Chrome tab`);
      return;
    }
    const result = workspace.openUrl(target.url);
    if (!result.ok) {
      setProblem(result.message);
      announce(result.message);
      return;
    }
    requestClose();
    setView('browse');
    announce(`Opening ${target.host}`);
  };

  const onInputKeyDown = (event: React.KeyboardEvent<HTMLInputElement>) => {
    switch (event.key) {
      case 'ArrowDown':
        event.preventDefault();
        setSelected(moveSelection(current, 1, rows.length));
        break;
      case 'ArrowUp':
        event.preventDefault();
        setSelected(moveSelection(current, -1, rows.length));
        break;
      case 'Enter':
        event.preventDefault();
        activate(rows[current]);
        break;
    }
  };

  // Focus stays inside: Tab and Shift+Tab cycle through the input, the close chip and the filters.
  const onDialogKeyDown = (event: React.KeyboardEvent<HTMLDialogElement>) => {
    if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      requestClose();
      return;
    }
    if (event.key !== 'Tab') return;
    const items = [...event.currentTarget.querySelectorAll<HTMLElement>(FOCUSABLE)];
    if (items.length === 0) return;
    const first = items[0];
    const last = items[items.length - 1];
    const at = document.activeElement;
    if (event.shiftKey && (at === first || !event.currentTarget.contains(at))) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && (at === last || !event.currentTarget.contains(at))) {
      event.preventDefault();
      first.focus();
    }
  };

  const chooseFilter = (next: PaletteFilter) => {
    setFilter(next);
    setSelected(0);
  };

  const shownCount = filtered.length;

  return (
    <dialog
      ref={dialogRef}
      className="tk-palette"
      aria-labelledby={titleId}
      onClose={finish}
      onCancel={(event) => {
        event.preventDefault();
        requestClose();
      }}
      onKeyDown={onDialogKeyDown}
      onClick={(event) => {
        // A click outside the panel lands on the dialog itself (the scrim).
        if (event.target === event.currentTarget) requestClose();
      }}
    >
      <div className="tk-palette-panel">
        <h2 id={titleId} className="tk-visually-hidden">
          Search sessions
        </h2>
        <div className="tk-palette-input-row">
          <Icon name="search" size={18} className="tk-palette-input-icon" />
          <input
            ref={inputRef}
            className="tk-palette-input"
            type="text"
            role="combobox"
            aria-expanded="true"
            aria-controls={listId}
            aria-autocomplete="list"
            aria-activedescendant={current >= 0 ? optionId(current) : undefined}
            aria-label="Search sessions or enter an address"
            placeholder="Search sessions or enter an address"
            spellCheck={false}
            autoComplete="off"
            autoCapitalize="off"
            value={query}
            onChange={(event) => {
              setQuery(event.target.value);
              setSelected(0);
              setProblem(null);
            }}
            onKeyDown={onInputKeyDown}
          />
          <button type="button" className="tk-palette-esc" aria-label="Close" title="Close (Escape)" onClick={requestClose}>
            <kbd className="tk-palette-kbd">esc</kbd>
          </button>
        </div>

        <div className="tk-palette-filters" role="group" aria-label="Show">
          {PALETTE_FILTERS.map((option, index) => {
            const on = filter === option.id;
            const divider = index > 0 && PALETTE_FILTERS[index - 1].family !== 'type' && option.family === 'type';
            return (
              <React.Fragment key={option.id}>
                {divider && <span className="tk-palette-divider" aria-hidden="true" />}
                <button
                  type="button"
                  className="tk-palette-chip"
                  data-filter={option.id}
                  aria-pressed={on}
                  onClick={() => chooseFilter(option.id)}
                >
                  {option.id === 'needs' || option.id === 'running' ? (
                    <span className="tk-palette-chip-dot" data-run={option.id} aria-hidden="true" />
                  ) : null}
                  <span>{option.label}</span>
                  <span className="tk-palette-count">
                    {counts[option.id]}
                    <span className="tk-visually-hidden"> {counts[option.id] === 1 ? 'session' : 'sessions'}</span>
                  </span>
                </button>
              </React.Fragment>
            );
          })}
        </div>

        {problem && (
          <p className="tk-palette-problem" role="status">
            <Icon name="alert" size={14} />
            <span>{problem}</span>
          </p>
        )}

        {rows.length === 0 ? (
          <p className="tk-palette-empty" id={listId}>
            {query.trim() ? 'No sessions match. Try other words, or another filter.' : 'No sessions here yet.'}
          </p>
        ) : (
          <ul className="tk-palette-list" id={listId} role="listbox" aria-label="Sessions">
            {rows.map((row, index) => (
              <li
                key={row.kind === 'address' ? 'address' : row.session.conversation.threadKey}
                id={optionId(index)}
                role="option"
                aria-selected={index === current}
                className="tk-palette-option"
                data-kind={row.kind}
                onMouseMove={() => {
                  if (index !== current) setSelected(index);
                }}
                onMouseDown={(event) => event.preventDefault()}
                onClick={() => activate(row)}
              >
                {row.kind === 'address' ? <AddressOption address={row.address} /> : <SessionOption session={row.session} />}
              </li>
            ))}
          </ul>
        )}

        <div className="tk-palette-foot">
          <span className="tk-palette-keys" aria-hidden="true">
            <kbd className="tk-palette-kbd">↑</kbd>
            <kbd className="tk-palette-kbd">↓</kbd>
            <span>Move</span>
            <kbd className="tk-palette-kbd">↵</kbd>
            <span>Open</span>
            <kbd className="tk-palette-kbd">esc</kbd>
            <span>Close</span>
          </span>
          <span className="tk-palette-total" aria-live="polite">
            <b>{shownCount.toLocaleString()}</b> of {total.toLocaleString()} {total === 1 ? 'session' : 'sessions'}
            {shownCount > PALETTE_RENDER_LIMIT ? ` · first ${PALETTE_RENDER_LIMIT} shown` : ''}
          </span>
        </div>
      </div>
    </dialog>
  );
}

function SessionOption({ session }: { session: PaletteSession }) {
  const { accountOfThread } = useWorkspaceContext();
  const conv = session.conversation;
  const owner = accountOfThread(conv);
  return (
    <>
      <ProviderMark provider={conv.provider} />
      <span className="tk-palette-text">
        <span className="tk-palette-title">{session.title}</span>
        <span className="tk-palette-meta">
          <span>{SESSION_GROUP_LABELS[session.group]}</span>
          {owner.account && (
            <>
              <span className="tk-palette-sep" aria-hidden="true">
                ·
              </span>
              <span className="tk-visually-hidden">, </span>
              <AccountChip account={owner.account} active={owner.active} />
            </>
          )}
        </span>
      </span>
      <span className="tk-palette-run">
        <span className="tk-visually-hidden">, </span>
        {session.rank < 2 || (session.run && session.run !== 'idle') ? (
          <RunState state={session.run} observedAt={conv.agentStateAt} />
        ) : (
          <span className="tk-run tk-palette-idle" data-state="none">
            <span className="tk-run-dot" aria-hidden="true" />
            <span className="tk-run-label">Idle</span>
          </span>
        )}
      </span>
    </>
  );
}

function AddressOption({ address }: { address: PaletteAddress }) {
  return (
    <>
      <span className="tk-palette-glyph" aria-hidden="true">
        <Icon name={address.kind === 'open' ? 'browse' : 'external'} size={16} />
      </span>
      <span className="tk-palette-text">
        <span className="tk-palette-title">
          Open <b>{address.host}</b>
          <span className="tk-palette-path">{address.path}</span>
          {address.kind === 'chrome' ? ' in a Chrome tab' : ''}
        </span>
        <span className="tk-palette-meta">
          {address.kind === 'open' ? 'Address · opens as a new tab in Browse' : 'ThreadStack shows the AI sites it knows; this one opens in Chrome'}
        </span>
      </span>
    </>
  );
}
