// Small building blocks every workspace view shares. Markup and behaviour only; their look is
// in styles/00-foundation.css under the same class names.
import React, { useCallback, useEffect, useId, useRef, useState } from 'react';
import { PROVIDERS, type ProviderId } from '../../../core/providers.js';
import { realmForProvider } from '../../../core/workspace/realms.js';
import {
  AGENT_STATE_LABELS,
  agentStateNeedsYou,
  type AccountRecord,
  type AgentState,
} from '../../../core/workspace/types.js';
import { Icon, type IconName } from './icons.js';

// ---------------------------------------------------------------------------------------------
// Provider mark
// ---------------------------------------------------------------------------------------------

/** Two letters per provider. A neutral monogram, never a logo: the page itself carries the brand. */
const MONOGRAMS: Partial<Record<ProviderId, string>> = {
  chatgpt: 'GP',
  claude: 'CL',
  claude_code: 'CC',
  codex: 'CX',
  grok: 'GK',
  grok_x: 'GX',
  grok_bot: 'XB',
  gemini: 'GM',
  ai_studio: 'AS',
  perplexity: 'PX',
  deepseek: 'DS',
  mistral: 'MI',
  copilot: 'CP',
  kimi: 'KI',
  chatgpt_dots: 'DT',
  claude_duet: 'DU',
  muse: 'MU',
  meta_ai: 'MA',
  cursor_agents: 'CU',
  github_copilot: 'GH',
  devin: 'DV',
  jules: 'JU',
  paperclip: 'PC',
  imported: 'IM',
};

export function providerMonogram(provider: ProviderId | string | null): string {
  if (!provider) return '··';
  const known = MONOGRAMS[provider as ProviderId];
  if (known) return known;
  const label = PROVIDERS[provider as ProviderId]?.label ?? String(provider);
  const words = label.split(/[\s_-]+/).filter(Boolean);
  return ((words[0]?.[0] ?? '·') + (words[1]?.[0] ?? words[0]?.[1] ?? '·')).toUpperCase();
}

export function providerName(provider: ProviderId | string | null): string {
  return provider ? PROVIDERS[provider as ProviderId]?.label ?? String(provider) : 'Site';
}

export function ProviderMark({ provider, size = 'md' }: { provider: ProviderId | string | null; size?: 'sm' | 'md' }) {
  return (
    <span className="tk-mark" data-size={size} aria-hidden="true">
      {providerMonogram(provider)}
    </span>
  );
}

// ---------------------------------------------------------------------------------------------
// Accounts
// ---------------------------------------------------------------------------------------------

/** How an account is named in one line: its label, then who the site says it is. */
export function accountSubtitle(account: AccountRecord, browserAccount = false): string {
  if (account.identity?.display) return account.identity.display;
  if (browserAccount || account.primary) return 'This browser’s sign-in';
  if (!account.hasJar || account.signedIn === 'no') return 'Not signed in yet';
  return 'Signed in, name not shown by the site';
}

/**
 * An account's colour dot and name. The dot is filled when the account is the one signed in to
 * its realm and a hollow ring when it is not, so the difference never rests on colour alone.
 */
export function AccountChip({
  account,
  active,
  showName = true,
  fallbackLabel = 'Removed account',
}: {
  account: Pick<AccountRecord, 'label' | 'color'> | null;
  /** Whether this account is signed in (the browser's own sign-in, or a profile with a saved one). */
  active: boolean;
  showName?: boolean;
  fallbackLabel?: string;
}) {
  const label = account?.label ?? fallbackLabel;
  const state = active ? 'signed in' : 'not signed in';
  return (
    <span className="tk-acct" data-color={account?.color ?? 'none'} data-active={active ? 'true' : 'false'} title={`${label} (${state})`}>
      <span className="tk-acct-dot" aria-hidden="true" />
      {showName ? <span className="tk-acct-name">{label}</span> : <span className="tk-visually-hidden">{label}</span>}
      <span className="tk-visually-hidden">, {state}</span>
    </span>
  );
}

/** Provider + realm sentence used in paused states: "Claude is signed in as Work." */
export function realmNameFor(provider: ProviderId | string | null): string {
  const realm = provider ? realmForProvider(provider as ProviderId) : null;
  return realm?.label ?? providerName(provider);
}

// ---------------------------------------------------------------------------------------------
// Run state of a coding-agent session
// ---------------------------------------------------------------------------------------------

/**
 * What the page last showed about a run, as a dot and a word. `unknown` renders nothing: no
 * state was observed, and saying "Idle" or "Running" would be a guess.
 */
export function RunState({
  state,
  observedAt,
  compact = false,
}: {
  state: AgentState | null | undefined;
  observedAt?: string | null;
  /** Dot only (the word stays available to assistive tech and as a tooltip). */
  compact?: boolean;
}) {
  if (!state || state === 'unknown') return null;
  const label = AGENT_STATE_LABELS[state];
  const when = observedAt ? ` Seen ${new Date(observedAt).toLocaleString()}.` : '';
  return (
    <span
      className="tk-run"
      data-state={state}
      data-needs-you={agentStateNeedsYou(state) ? 'true' : 'false'}
      title={`${label}.${when} This is what the page showed when Threadkeeper last read it.`}
    >
      <span className="tk-run-dot" aria-hidden="true" />
      {compact ? <span className="tk-visually-hidden">{label}</span> : <span className="tk-run-label">{label}</span>}
    </span>
  );
}

// ---------------------------------------------------------------------------------------------
// Segmented control
// ---------------------------------------------------------------------------------------------

export interface SegmentOption<T extends string | number> {
  value: T;
  label: string;
  icon?: IconName;
  /** Shown instead of the label when the control is icon-only; the label stays as the name. */
  hideLabel?: boolean;
  disabled?: boolean;
}

/**
 * A small set of mutually exclusive choices with a sliding thumb. Radio semantics: arrow keys
 * move the choice, Tab moves past the group.
 */
export function Segmented<T extends string | number>({
  label,
  value,
  options,
  onChange,
  className,
}: {
  /** Accessible name of the group. */
  label: string;
  value: T;
  options: ReadonlyArray<SegmentOption<T>>;
  onChange: (value: T) => void;
  className?: string;
}) {
  const index = Math.max(0, options.findIndex((o) => o.value === value));
  const refs = useRef<Array<HTMLButtonElement | null>>([]);
  const move = (from: number, step: number) => {
    for (let i = 1; i <= options.length; i++) {
      const next = (from + step * i + options.length * i) % options.length;
      if (!options[next].disabled) {
        onChange(options[next].value);
        refs.current[next]?.focus();
        return;
      }
    }
  };
  return (
    <div
      className={className ? `tk-seg ${className}` : 'tk-seg'}
      role="radiogroup"
      aria-label={label}
      style={{ '--n': options.length, '--i': index } as React.CSSProperties}
    >
      <span className="tk-seg-thumb" aria-hidden="true" />
      {options.map((option, i) => (
        <button
          key={String(option.value)}
          ref={(el) => {
            refs.current[i] = el;
          }}
          type="button"
          role="radio"
          className="tk-seg-item"
          aria-checked={i === index}
          aria-label={option.hideLabel ? option.label : undefined}
          title={option.hideLabel ? option.label : undefined}
          tabIndex={i === index ? 0 : -1}
          disabled={option.disabled}
          onClick={() => onChange(option.value)}
          onKeyDown={(event) => {
            if (event.key === 'ArrowRight' || event.key === 'ArrowDown') {
              event.preventDefault();
              move(i, 1);
            } else if (event.key === 'ArrowLeft' || event.key === 'ArrowUp') {
              event.preventDefault();
              move(i, -1);
            }
          }}
        >
          {option.icon && <Icon name={option.icon} />}
          {!option.hideLabel && <span>{option.label}</span>}
        </button>
      ))}
    </div>
  );
}

// ---------------------------------------------------------------------------------------------
// Menus
// ---------------------------------------------------------------------------------------------

let openPopovers = 0;

/**
 * Whether a menu is open right now. The page-level Escape handler asks this first, so Escape
 * closes the menu and nothing behind it.
 */
export function hasOpenPopover(): boolean {
  return openPopovers > 0;
}

/**
 * Open and close behaviour for a menu that floats over the page: Escape and a click elsewhere
 * close it, and so does the window losing focus. That last one matters here because a click
 * inside an embedded page never reaches this document, so without it a menu would stay open
 * over the page the person just clicked into.
 */
export function usePopover(): {
  open: boolean;
  setOpen: (open: boolean) => void;
  toggle: () => void;
  /** Spread on the button that opens the menu. */
  triggerProps: {
    ref: React.RefObject<HTMLButtonElement>;
    'aria-haspopup': 'menu';
    'aria-expanded': boolean;
    'aria-controls': string;
    onClick: () => void;
  };
  /** Spread on the menu element. */
  menuProps: { ref: React.RefObject<HTMLDivElement>; id: string; role: 'menu' };
} {
  const [open, setOpenState] = useState(false);
  const trigger = useRef<HTMLButtonElement>(null);
  const menu = useRef<HTMLDivElement>(null);
  const id = useId();
  const setOpen = useCallback((next: boolean) => setOpenState(next), []);
  const close = useCallback((refocus: boolean) => {
    setOpenState(false);
    if (refocus) trigger.current?.focus();
  }, []);

  useEffect(() => {
    if (!open) return;
    openPopovers += 1;
    const onPointer = (event: PointerEvent) => {
      const target = event.target as Node | null;
      if (target && (menu.current?.contains(target) || trigger.current?.contains(target))) return;
      close(false);
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      // The page-level Escape handler steps aside while a menu is open (hasOpenPopover).
      event.preventDefault();
      event.stopPropagation();
      close(true);
    };
    const onBlur = () => close(false);
    document.addEventListener('pointerdown', onPointer, true);
    document.addEventListener('keydown', onKey, true);
    window.addEventListener('blur', onBlur);
    // Move focus into the menu so arrow keys and Tab start from its first item.
    const first = menu.current?.querySelector<HTMLElement>('[role^="menuitem"]:not([disabled]), button:not([disabled])');
    first?.focus();
    return () => {
      openPopovers -= 1;
      document.removeEventListener('pointerdown', onPointer, true);
      document.removeEventListener('keydown', onKey, true);
      window.removeEventListener('blur', onBlur);
    };
  }, [open, close]);

  return {
    open,
    setOpen,
    toggle: () => setOpenState((v) => !v),
    triggerProps: {
      ref: trigger,
      'aria-haspopup': 'menu',
      'aria-expanded': open,
      'aria-controls': id,
      onClick: () => setOpenState((v) => !v),
    },
    menuProps: { ref: menu, id, role: 'menu' },
  };
}

/** Arrow-key movement between the items of an open menu. Put on the menu element. */
export function onMenuKeyDown(event: React.KeyboardEvent<HTMLElement>): void {
  if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp' && event.key !== 'Home' && event.key !== 'End') return;
  const items = [...event.currentTarget.querySelectorAll<HTMLElement>('[role^="menuitem"]:not([disabled])')];
  if (items.length === 0) return;
  event.preventDefault();
  const at = items.indexOf(document.activeElement as HTMLElement);
  const next =
    event.key === 'Home' ? 0 : event.key === 'End' ? items.length - 1 : event.key === 'ArrowDown' ? (at + 1) % items.length : (at - 1 + items.length) % items.length;
  items[next].focus();
}

// ---------------------------------------------------------------------------------------------
// States of a place where a page should be
// ---------------------------------------------------------------------------------------------

/**
 * A plain block for "nothing here yet", "paused" and "could not load": what happened, then what
 * to do. `actions` are the buttons; the first is the main one.
 */
export function Notice({
  icon,
  title,
  children,
  actions,
  tone = 'plain',
}: {
  icon?: IconName;
  title: string;
  children?: React.ReactNode;
  actions?: React.ReactNode;
  tone?: 'plain' | 'warn';
}) {
  return (
    <div className="tk-notice" data-tone={tone}>
      {icon && (
        <span className="tk-notice-icon">
          <Icon name={icon} size={18} />
        </span>
      )}
      <h3 className="tk-notice-title">{title}</h3>
      {children && <div className="tk-notice-body">{children}</div>}
      {actions && <div className="tk-notice-actions">{actions}</div>}
    </div>
  );
}
