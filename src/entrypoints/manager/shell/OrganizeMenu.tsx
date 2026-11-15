// The one "Organize" menu the side navigation and the Dashboard share: Group by, Sort by, and
// which sessions to Show. The choices and their meaning live in workspace/lens.ts; this file is
// the button, the menu, and the hooks that connect a surface to its saved group and sort and to
// its (unsaved) filters.
import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { createPortal } from 'react-dom';
import { providerLabel, type ProviderId } from '../../../core/providers.js';
import type { ConversationRecord, SurfaceLens } from '../../../core/schema.js';
import { useLensFilters, useWorkspaceContext, type LensFilterSurface } from '../workspace/context.js';
import {
  DEFAULT_LENS_SORT,
  EMPTY_LENS_FILTERS,
  LENS_GROUP_BY_LABELS,
  LENS_SORT,
  LENS_SORT_LABELS,
  SESSION_KINDS,
  SESSION_KIND_LABELS,
  SURFACE_DEFAULT_GROUP_BY,
  availableGroupBy,
  countLens,
  isLensFiltered,
  lensFilterCount,
  sanitizeGroupBy,
  sanitizeSort,
  selfConversation,
  toggleLensFilter,
  type AccountIdOf,
  type LensCounts,
  type LensFacts,
  type LensFilters,
  type LensGroupBy,
  type LensSort,
  type SessionKind,
} from '../workspace/lens.js';
import { Icon } from './icons.js';
import { onMenuKeyDown, usePopover } from './primitives.js';

// ---------------------------------------------------------------------------------------------
// What the library has: the numbers and names the menu and the filter line need
// ---------------------------------------------------------------------------------------------

export interface AccountOption {
  id: string;
  /** "<Sign-in> · <Account>" */
  label: string;
  count: number;
}

export interface LensUniverse {
  counts: LensCounts;
  accountIdOf: AccountIdOf;
  /** Every known account in sign-in order, then account order. */
  accountOrder: string[];
  accounts: AccountOption[];
  facts: LensFacts;
  /** The active filters as short names, in the order the menu lists them. */
  describeFilters: (filters: LensFilters) => string[];
}

/** Counts and names over the sessions a surface lists (before its filters narrow them). */
export function useLensUniverse(sessions: readonly ConversationRecord[]): LensUniverse {
  const { workspace, accountOfThread } = useWorkspaceContext();
  const realms = workspace.realms;
  const accountIdOf = useCallback<AccountIdOf>((conv) => accountOfThread(conv).account?.id ?? null, [accountOfThread]);
  const counts = useMemo(() => countLens(sessions, selfConversation, accountIdOf), [sessions, accountIdOf]);
  const known = useMemo(
    () => realms.flatMap((r) => r.accounts.map((a) => ({ id: a.id, label: `${r.realm.label} · ${a.label}` }))),
    [realms]
  );
  const accountOrder = useMemo(() => known.map((a) => a.id), [known]);
  const accounts = useMemo(() => known.map((a) => ({ ...a, count: counts.accounts.get(a.id) ?? 0 })), [known, counts]);
  const multiAccount = realms.some((r) => r.accounts.length > 1);
  const facts = useMemo<LensFacts>(
    () => ({ multiAccount, kindCount: counts.kinds.size, providerCount: counts.providers.size }),
    [multiAccount, counts]
  );
  const describeFilters = useCallback(
    (filters: LensFilters) => [
      ...SESSION_KINDS.filter((k) => filters.kinds.includes(k)).map((k) => SESSION_KIND_LABELS[k]),
      ...filters.providers.map((p) => providerLabel(p)),
      ...filters.accounts.map((id) => known.find((a) => a.id === id)?.label ?? 'Removed account'),
    ],
    [known]
  );
  return { counts, accountIdOf, accountOrder, accounts, facts, describeFilters };
}

// ---------------------------------------------------------------------------------------------
// A surface's lens: saved group and sort, unsaved filters
// ---------------------------------------------------------------------------------------------

export interface SurfaceLensState {
  groupBy: LensGroupBy;
  sortBy: LensSort;
  filters: LensFilters;
  setGroupBy: (groupBy: LensGroupBy) => void;
  setSortBy: (sortBy: LensSort) => void;
  setFilters: (filters: LensFilters) => void;
  /** Back to the surface's defaults, with no filters. */
  reset: () => void;
}


/**
 * Group and sort come from (and are written to) the settings, one record per surface. Filters are
 * held above the views by WorkspaceProvider and never written anywhere.
 */
export function useSurfaceLens(surface: LensFilterSurface): SurfaceLensState {
  const { settings, patchSettings, announce } = useWorkspaceContext();
  const [filters, setFilters] = useLensFilters(surface);
  const stored = surface === 'sidebar' ? settings?.railLens : settings?.dashboardLens;
  const groupBy = sanitizeGroupBy(surface, stored?.groupBy);
  const sortBy = sanitizeSort(stored?.sortBy);
  const save = (next: SurfaceLens) => void patchSettings(surface === 'sidebar' ? { railLens: next } : { dashboardLens: next });
  return {
    groupBy,
    sortBy,
    filters,
    setGroupBy: (value) => {
      save({ groupBy: value, sortBy });
      announce(value === 'none' ? 'Sessions are no longer grouped.' : `Sessions grouped by ${LENS_GROUP_BY_LABELS[value].toLowerCase()}.`);
    },
    setSortBy: (value) => {
      save({ groupBy, sortBy: value });
      announce(`Sessions sorted by ${LENS_SORT_LABELS[value].toLowerCase()}.`);
    },
    setFilters,
    reset: () => {
      save({ groupBy: SURFACE_DEFAULT_GROUP_BY[surface], sortBy: DEFAULT_LENS_SORT });
      setFilters(EMPTY_LENS_FILTERS);
      announce('Grouping, order and filters are back to the defaults.');
    },
  };
}

// ---------------------------------------------------------------------------------------------
// The menu
// ---------------------------------------------------------------------------------------------

const MENU_WIDTH = 288;
const EDGE = 8;

interface MenuPlace {
  left: number;
  top: number;
}

export interface OrganizeMenuProps {
  surface: LensFilterSurface;
  universe: LensUniverse;
  groupBy: LensGroupBy;
  sortBy: LensSort;
  filters: LensFilters;
  onGroupBy: (groupBy: LensGroupBy) => void;
  onSortBy: (sortBy: LensSort) => void;
  onFilters: (filters: LensFilters) => void;
  onReset: () => void;
  /** `side`: opens beside the button (the rail); `below`: under it (a bar). */
  placement?: 'side' | 'below';
}

function countWords(count: number): string {
  return `${count} ${count === 1 ? 'session' : 'sessions'}`;
}

export function OrganizeMenu({
  surface,
  universe,
  groupBy,
  sortBy,
  filters,
  onGroupBy,
  onSortBy,
  onFilters,
  onReset,
  placement = 'below',
}: OrganizeMenuProps) {
  const popover = usePopover();
  const [place, setPlace] = useState<MenuPlace | null>(null);
  const { open } = popover;
  const active = lensFilterCount(filters);
  const differs = isLensFiltered(filters) || groupBy !== SURFACE_DEFAULT_GROUP_BY[surface] || sortBy !== DEFAULT_LENS_SORT;
  const idBase = popover.menuProps.id;

  const measure = useCallback(() => {
    const button = popover.triggerProps.ref.current;
    if (!button) return;
    const r = button.getBoundingClientRect();
    const maxLeft = Math.max(EDGE, window.innerWidth - MENU_WIDTH - EDGE);
    if (placement === 'side') setPlace({ left: Math.min(r.right + EDGE, maxLeft), top: Math.max(EDGE, r.top - 4) });
    else setPlace({ left: Math.min(Math.max(EDGE, r.left), maxLeft), top: r.bottom + 6 });
  }, [placement, popover.triggerProps.ref]);

  useEffect(() => {
    if (!open) {
      setPlace(null);
      return;
    }
    window.addEventListener('resize', measure);
    return () => window.removeEventListener('resize', measure);
  }, [open, measure]);

  const groupOptions = availableGroupBy(surface, universe.facts, groupBy);
  const kinds = SESSION_KINDS.filter((k) => (universe.counts.kinds.get(k) ?? 0) > 0 || filters.kinds.includes(k));
  const providers = [...new Set<ProviderId>([...universe.counts.providers.keys(), ...filters.providers])].sort(
    (a, b) => (universe.counts.providers.get(b) ?? 0) - (universe.counts.providers.get(a) ?? 0) || providerLabel(a).localeCompare(providerLabel(b))
  );
  const accounts = universe.facts.multiAccount ? universe.accounts.filter((a) => a.count > 0 || filters.accounts.includes(a.id)) : [];

  const filterItem = (key: string, label: string, count: number, checked: boolean, onToggle: () => void) => (
    <button key={key} type="button" role="menuitemcheckbox" aria-checked={checked} className="tk-pop-item tk-org-item" onClick={onToggle}>
      <span className="tk-org-mark">{checked && <Icon name="check" size={14} />}</span>
      <span className="tk-org-label">{label}</span>
      <span className="tk-org-count tk-tabular" aria-hidden="true">
        {count}
      </span>
      <span className="tk-visually-hidden">, {countWords(count)}</span>
    </button>
  );

  return (
    <>
      <button
        type="button"
        className="tk-icon-btn tk-org-btn"
        data-active={active > 0 ? 'true' : undefined}
        title="Group, sort and filter"
        {...popover.triggerProps}
        aria-controls={open ? idBase : undefined}
        onClick={() => {
          if (!open) measure();
          popover.toggle();
        }}
      >
        <Icon name="organize" />
        {active > 0 && (
          <span className="tk-org-badge tk-tabular" aria-hidden="true">
            {active}
          </span>
        )}
        <span className="tk-visually-hidden">
          Organize{active > 0 ? `, ${active} ${active === 1 ? 'filter' : 'filters'} on` : ''}
        </span>
      </button>
      {open &&
        place &&
        createPortal(
          <div
            {...popover.menuProps}
            className="tk-pop tk-org-menu"
            aria-label="Organize sessions"
            tabIndex={-1}
            style={{ left: place.left, top: place.top, maxHeight: Math.max(200, window.innerHeight - place.top - EDGE) }}
            onKeyDown={onMenuKeyDown}
          >
            <div role="group" aria-labelledby={`${idBase}-group`}>
              <div className="tk-org-head" id={`${idBase}-group`}>
                Group by
              </div>
              {groupOptions.map((value) => (
                <button
                  key={value}
                  type="button"
                  role="menuitemradio"
                  aria-checked={value === groupBy}
                  className="tk-pop-item tk-org-item"
                  onClick={() => onGroupBy(value)}
                >
                  <span className="tk-org-mark">{value === groupBy && <Icon name="check" size={14} />}</span>
                  <span className="tk-org-label">{LENS_GROUP_BY_LABELS[value]}</span>
                </button>
              ))}
            </div>
            <div className="tk-pop-sep" role="separator" />
            <div role="group" aria-labelledby={`${idBase}-sort`}>
              <div className="tk-org-head" id={`${idBase}-sort`}>
                Sort by
              </div>
              {LENS_SORT.map((value) => (
                <button
                  key={value}
                  type="button"
                  role="menuitemradio"
                  aria-checked={value === sortBy}
                  className="tk-pop-item tk-org-item"
                  onClick={() => onSortBy(value)}
                >
                  <span className="tk-org-mark">{value === sortBy && <Icon name="check" size={14} />}</span>
                  <span className="tk-org-label">{LENS_SORT_LABELS[value]}</span>
                </button>
              ))}
            </div>
            <div className="tk-pop-sep" role="separator" />
            <div role="group" aria-labelledby={`${idBase}-show`}>
              <div className="tk-org-head" id={`${idBase}-show`}>
                Show
              </div>
              <div role="group" aria-label="Type">
                <div className="tk-org-sub" aria-hidden="true">
                  Type
                </div>
                {kinds.map((kind: SessionKind) =>
                  filterItem(`kind-${kind}`, SESSION_KIND_LABELS[kind], universe.counts.kinds.get(kind) ?? 0, filters.kinds.includes(kind), () =>
                    onFilters(toggleLensFilter(filters, 'kinds', kind))
                  )
                )}
              </div>
              {providers.length > 0 && (
                <div role="group" aria-label="Provider">
                  <div className="tk-org-sub" aria-hidden="true">
                    Provider
                  </div>
                  {providers.map((provider) =>
                    filterItem(
                      `provider-${provider}`,
                      providerLabel(provider),
                      universe.counts.providers.get(provider) ?? 0,
                      filters.providers.includes(provider),
                      () => onFilters(toggleLensFilter(filters, 'providers', provider))
                    )
                  )}
                </div>
              )}
              {accounts.length > 0 && (
                <div role="group" aria-label="Account">
                  <div className="tk-org-sub" aria-hidden="true">
                    Account
                  </div>
                  {accounts.map((account) =>
                    filterItem(`account-${account.id}`, account.label, account.count, filters.accounts.includes(account.id), () =>
                      onFilters(toggleLensFilter(filters, 'accounts', account.id))
                    )
                  )}
                </div>
              )}
            </div>
            {differs && (
              <>
                <div className="tk-pop-sep" role="separator" />
                <button type="button" role="menuitem" className="tk-pop-item tk-org-item tk-org-reset" onClick={onReset}>
                  <span className="tk-org-mark" />
                  <span className="tk-org-label">Reset</span>
                </button>
              </>
            )}
          </div>,
          document.body
        )}
    </>
  );
}
