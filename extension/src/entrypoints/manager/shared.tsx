import React from 'react';
import { ThreadStackDB } from '../../core/db.js';
import {
  THREAD_KIND_LABELS,
  type CoverageState,
  type ProjectSource,
  type ThreadKind,
  type WorkflowState,
} from '../../core/schema.js';

export const sharedDb = new ThreadStackDB();

export function notifyBackground(message: Record<string, unknown>): void {
  if (typeof chrome === 'undefined' || !chrome.runtime?.sendMessage) return;
  try {
    void chrome.runtime.sendMessage(message).catch(() => undefined);
  } catch {
    // extension context invalidated
  }
}

export function CoverageTick({ coverage }: { coverage: CoverageState }) {
  const filledCount = coverage === 'full' ? 3 : coverage === 'partial' ? 2 : 1;
  return (
    <span className="tk-coverage-tick" title={`Capture coverage: ${coverage} (${filledCount}/3)`}>
      <span className="tk-coverage-bars" aria-hidden="true">
        <span className="tk-coverage-bar" data-filled={filledCount >= 1} />
        <span className="tk-coverage-bar" data-filled={filledCount >= 2} />
        <span className="tk-coverage-bar" data-filled={filledCount >= 3} />
      </span>
      <span>{coverage}</span>
    </span>
  );
}

export const WORKFLOW_LABELS: Record<WorkflowState, string> = {
  active: 'Active',
  needs_review: 'Needs review',
  waiting: 'Waiting',
  paused: 'Paused',
  done: 'Done',
  archived: 'Archived',
};

export function StatusPill({ state }: { state: WorkflowState }) {
  return (
    <span className="tk-status-pill">
      <span className="tk-status-dot" data-state={state} aria-hidden="true" />
      <span>{WORKFLOW_LABELS[state]}</span>
    </span>
  );
}

export function KindLabel({ kind }: { kind: ThreadKind }) {
  return <span className="tk-kind" data-kind={kind}>{THREAD_KIND_LABELS[kind]}</span>;
}

export const PROJECT_SOURCE_LABELS: Record<ProjectSource, string> = {
  default: 'not filed yet',
  import: 'from import',
  provider: 'from the provider project',
  ai: 'filed by Claude',
  rules: 'filed by keyword rule',
  similar: 'filed by similarity',
  cluster: 'grouped automatically',
  manual: 'filed by you',
};

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

export function relativeTime(iso: string | null | undefined, nowMs = Date.now()): string {
  if (!iso) return 'unknown';
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return 'unknown';
  const diff = nowMs - t;
  const min = Math.round(diff / 60_000);
  if (min < 1) return 'just now';
  if (min < 60) return `${min}m ago`;
  const hours = Math.round(min / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.round(hours / 24);
  if (days === 1) return 'yesterday';
  if (days < 7) return `${days}d ago`;
  const d = new Date(t);
  const sameYear = d.getFullYear() === new Date(nowMs).getFullYear();
  return `${MONTHS[d.getMonth()]} ${d.getDate()}${sameYear ? '' : `, ${d.getFullYear()}`}`;
}

export function openModal(ref: React.MutableRefObject<HTMLDialogElement | null>): void {
  const el = ref.current;
  if (!el) return;
  if (typeof el.showModal === 'function') {
    if (!el.open) el.showModal();
  } else {
    el.setAttribute('open', 'true');
  }
}

/** Render text with [T3]-style citations as buttons. */
export function renderCitations(
  text: string,
  onCite: (index: number) => void,
  maxIndex: number
): React.ReactNode[] {
  const parts: React.ReactNode[] = [];
  const re = /\[T(\d+)\]/g;
  let last = 0;
  let m: RegExpExecArray | null;
  let key = 0;
  while ((m = re.exec(text))) {
    if (m.index > last) parts.push(text.slice(last, m.index));
    const n = Number(m[1]);
    if (n >= 1 && n <= maxIndex) {
      parts.push(
        <button key={`c${key++}`} type="button" className="tk-cite" onClick={() => onCite(n - 1)}>
          T{n}
        </button>
      );
    } else {
      parts.push(m[0]);
    }
    last = m.index + m[0].length;
  }
  if (last < text.length) parts.push(text.slice(last));
  return parts;
}
